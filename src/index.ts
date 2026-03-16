import PostalMime from 'postal-mime';

export interface Env {
  ACTIVE_EMAILS: KVNamespace;
  DB: D1Database;
  ATTACHMENTS_BUCKET: R2Bucket;
  EMAIL_NOTIFIER: DurableObjectNamespace;
}

export default {
  // ---------------------------------------------------------------------------
  // 1. API Handlers (Fetch)
  // ---------------------------------------------------------------------------
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // [POST] /api/generate - Create a new 10-minute email
    if (request.method === "POST" && url.pathname === "/api/generate") {
      const buffer = new Uint8Array(6);
      crypto.getRandomValues(buffer);
      const prefix = Array.from(buffer, b => b.toString(16).padStart(2, '0')).join('');
      const emailAddress = `${prefix}@temp.yourdomain.com`;

      // Store in KV with exactly 600 seconds (10 minutes) TTL
      await env.ACTIVE_EMAILS.put(emailAddress, "active", { expirationTtl: 600 });

      return Response.json({
        address: emailAddress,
        expires_in: 600,
        ws_url: `wss://${url.host}/api/ws/${emailAddress}`
      });
    }

    // [GET] /api/ws/:address - Upgrade to WebSocket for real-time notifications
    if (url.pathname.startsWith("/api/ws/")) {
      const address = url.pathname.replace("/api/ws/", "");
      
      const isActive = await env.ACTIVE_EMAILS.get(address);
      if (!isActive) {
        return new Response("Email address expired or invalid", { status: 403 });
      }

      // Route WebSocket request to the specific Durable Object for this address
      const id = env.EMAIL_NOTIFIER.idFromName(address);
      const stub = env.EMAIL_NOTIFIER.get(id);
      return stub.fetch(request);
    }

    // [GET] /api/emails/:address - Fetch inbox history
    if (request.method === "GET" && url.pathname.startsWith("/api/emails/")) {
      const address = url.pathname.replace("/api/emails/", "");
      
      const { results: emails } = await env.DB.prepare(
        "SELECT id, sender, subject, body_text, body_html, created_at FROM emails WHERE recipient = ? ORDER BY created_at DESC"
      ).bind(address).all();

      const { results: attachments } = await env.DB.prepare(
        "SELECT id, email_id, filename, content_type, size, r2_key FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE recipient = ?)"
      ).bind(address).all();

      // Map attachments to their respective emails
      const payload = emails.map(email => ({
        ...email,
        attachments: attachments.filter(att => att.email_id === email.id)
      }));

      return Response.json({ inbox: payload });
    }

    // [GET] /api/attachment/:r2_key - Download an attachment
    if (request.method === "GET" && url.pathname.startsWith("/api/attachment/")) {
      const encodedKey = url.pathname.replace("/api/attachment/", "");
      const r2Key = decodeURIComponent(encodedKey);
      
      const object = await env.ATTACHMENTS_BUCKET.get(r2Key);
      if (!object) return new Response("Attachment not found", { status: 404 });

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }

    return new Response("Not Found", { status: 404 });
  },

  // ---------------------------------------------------------------------------
  // 2. Email Catch-All Handler
  // ---------------------------------------------------------------------------
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // 1. Validate if the recipient is currently active in KV
    const isActive = await env.ACTIVE_EMAILS.get(message.to);
    if (!isActive) {
      message.setReject("Address has expired or does not exist.");
      return;
    }

    // 2. Parse the raw MIME stream
    const rawEmailBuffer = await new Response(message.raw).arrayBuffer();
    const parser = new PostalMime();
    const parsedEmail = await parser.parse(rawEmailBuffer);

    const emailId = crypto.randomUUID();
    const now = Date.now();

    // 3. Persist email metadata to D1
    await env.DB.prepare(
      `INSERT INTO emails (id, recipient, sender, subject, body_text, body_html, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      emailId, 
      message.to, 
      parsedEmail.from.address, 
      parsedEmail.subject || "(No Subject)",
      parsedEmail.text || "", 
      parsedEmail.html || "", 
      now
    ).run();

    // 4. Extract, store attachments to R2, and save metadata to D1
    const attachmentRecords = [];
    if (parsedEmail.attachments && parsedEmail.attachments.length > 0) {
      const stmt = env.DB.prepare(
        `INSERT INTO attachments (id, email_id, filename, content_type, r2_key, size) VALUES (?, ?, ?, ?, ?, ?)`
      );
      
      const batch = [];
      for (const att of parsedEmail.attachments) {
        const attId = crypto.randomUUID();
        const r2Key = `attachments/${message.to}/${emailId}/${attId}-${att.filename}`;
        
        await env.ATTACHMENTS_BUCKET.put(r2Key, att.content, {
          httpMetadata: { contentType: att.mimeType }
        });

        batch.push(stmt.bind(attId, emailId, att.filename, att.mimeType, r2Key, att.content.byteLength));
        attachmentRecords.push({ id: attId, filename: att.filename, r2_key: r2Key });
      }
      
      if (batch.length > 0) {
        await env.DB.batch(batch);
      }
    }

    // 5. Broadcast real-time event to Flutter via Durable Object
    const doId = env.EMAIL_NOTIFIER.idFromName(message.to);
    const stub = env.EMAIL_NOTIFIER.get(doId);
    
    // Asynchronously notify the DO without blocking the email delivery acknowledgement
    ctx.waitUntil(
      stub.fetch(new Request("http://internal/broadcast", {
        method: "POST",
        body: JSON.stringify({
          type: "NEW_EMAIL",
          payload: {
            id: emailId,
            sender: parsedEmail.from.address,
            subject: parsedEmail.subject,
            body_text: parsedEmail.text,
            created_at: now,
            attachments: attachmentRecords
          }
        })
      }))
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Durable Object: WebSocket Room Manager
// ---------------------------------------------------------------------------
export class EmailNotifier {
  private state: DurableObjectState;
  private sessions: Set<WebSocket>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.sessions = new Set();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal broadcast endpoint called by the Email worker
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const message = await request.text();
      
      for (const session of this.sessions) {
        try {
          session.send(message);
        } catch (err) {
          this.sessions.delete(session);
        }
      }
      return new Response("Broadcasted", { status: 200 });
    }

    // Client WebSocket Upgrade
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    
    // Accept and register the connection
    this.state.acceptWebSocket(server);
    this.sessions.add(server);

    // Cleanup on disconnect
    server.addEventListener("close", () => {
      this.sessions.delete(server);
    });

    server.addEventListener("error", () => {
      this.sessions.delete(server);
    });

    return new Response(null, { 
      status: 101, 
      webSocket: client 
    });
  }
}
