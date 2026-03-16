import PostalMime from 'postal-mime';
import { DurableObject } from "cloudflare:workers";

export interface Env {
  ACTIVE_EMAILS: KVNamespace;
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  NOTIFIER: DurableObjectNamespace;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  /**
   * HTTP REST API for the Client Application
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      // 1. Generate a new 10-minute email address
      if (request.method === 'POST' && url.pathname === '/api/generate') {
        const buffer = new Uint8Array(6);
        crypto.getRandomValues(buffer);
        const prefix = Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('');
        
        const domain = 'drkingbd.cc'; 
        const address = `${prefix}@${domain}`;

        // Store in KV with exactly 10 minutes (600 seconds) TTL
        await env.ACTIVE_EMAILS.put(address, 'active', { expirationTtl: 600 });

        const ws_url = url.protocol === 'https:' 
          ? `wss://${url.host}/api/ws/${address}` 
          : `ws://${url.host}/api/ws/${address}`;

        return Response.json({ address, expires_in: 600, ws_url }, { headers: CORS_HEADERS });
      }

      // 2. WebSocket Upgrade for Real-time Notifications
      if (request.method === 'GET' && url.pathname.startsWith('/api/ws/')) {
        const address = url.pathname.replace('/api/ws/', '');
        
        const isActive = await env.ACTIVE_EMAILS.get(address);
        if (!isActive) {
          return new Response('Email address expired or invalid', { status: 403, headers: CORS_HEADERS });
        }

        const doId = env.NOTIFIER.idFromName(address);
        const stub = env.NOTIFIER.get(doId);
        return stub.fetch(request);
      }

      // 3. Fetch Inbox History
      if (request.method === 'GET' && url.pathname.startsWith('/api/inbox/')) {
        const address = url.pathname.replace('/api/inbox/', '');

        const { results: emails } = await env.DB.prepare(
          `SELECT id, sender, subject, body_text, body_html, created_at 
           FROM emails WHERE address = ? ORDER BY created_at DESC`
        ).bind(address).all();

        const { results: attachments } = await env.DB.prepare(
          `SELECT id, email_id, filename, content_type, size, r2_key 
           FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE address = ?)`
        ).bind(address).all();

        const inbox = emails.map((email) => ({
          ...email,
          attachments: attachments
            .filter((att) => att.email_id === email.id)
            .map((att) => ({
               ...att,
               download_url: `${url.origin}/api/attachments/${encodeURIComponent(att.r2_key as string)}`
            })),
        }));

        return Response.json({ inbox }, { headers: CORS_HEADERS });
      }

      // 4. Download Attachment
      if (request.method === 'GET' && url.pathname.startsWith('/api/attachments/')) {
        const r2Key = decodeURIComponent(url.pathname.replace('/api/attachments/', ''));
        const object = await env.ATTACHMENTS.get(r2Key);

        if (!object) {
          return new Response('Attachment not found', { status: 404, headers: CORS_HEADERS });
        }

        const headers = new Headers(CORS_HEADERS as HeadersInit);
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);

        return new Response(object.body, { headers });
      }

      return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    } catch (error) {
      console.error('API Error:', error);
      return new Response('Internal Server Error', { status: 500, headers: CORS_HEADERS });
    }
  },

  /**
   * Cloudflare Email Worker - Triggered on incoming Catch-All emails
   */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      // Reject any email not actively generated in KV (Stops spam instantly)
      const isActive = await env.ACTIVE_EMAILS.get(message.to);
      if (!isActive) {
        message.setReject('Address has expired or does not exist.');
        return;
      }

      const rawEmailBuffer = await new Response(message.raw).arrayBuffer();
      const parser = new PostalMime();
      const parsedEmail = await parser.parse(rawEmailBuffer);

      const emailId = crypto.randomUUID();
      const now = Date.now();

      await env.DB.prepare(
        `INSERT INTO emails (id, address, sender, subject, body_text, body_html, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        emailId,
        message.to,
        parsedEmail.from?.address || 'unknown@sender.com',
        parsedEmail.subject || '(No Subject)',
        parsedEmail.text || '',
        parsedEmail.html || '',
        now
      ).run();

      const attachmentRecords: Array<Record<string, any>> = [];
      
      if (parsedEmail.attachments && parsedEmail.attachments.length > 0) {
        const stmt = env.DB.prepare(
          `INSERT INTO attachments (id, email_id, filename, content_type, size, r2_key) 
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        
        const batch = [];
        for (const att of parsedEmail.attachments) {
          const attId = crypto.randomUUID();
          const r2Key = `attachments/${message.to}/${emailId}/${attId}-${att.filename}`;
          
          await env.ATTACHMENTS.put(r2Key, att.content, {
            httpMetadata: { contentType: att.mimeType }
          });

          batch.push(stmt.bind(attId, emailId, att.filename, att.mimeType, att.content.byteLength, r2Key));
          
          attachmentRecords.push({
            id: attId,
            filename: att.filename,
            content_type: att.mimeType,
            size: att.content.byteLength,
            r2_key: r2Key
          });
        }
        
        if (batch.length > 0) {
          await env.DB.batch(batch); 
        }
      }

      const doId = env.NOTIFIER.idFromName(message.to);
      const stub = env.NOTIFIER.get(doId);
      
      const broadcastPayload = {
        type: 'NEW_EMAIL',
        payload: {
          id: emailId,
          sender: parsedEmail.from?.address || 'unknown',
          subject: parsedEmail.subject,
          body_text: parsedEmail.text,
          created_at: now,
          attachments: attachmentRecords
        }
      };

      ctx.waitUntil(
        stub.fetch(new Request('http://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify(broadcastPayload)
        }))
      );

    } catch (error) {
      console.error('Email processing failed:', error);
      message.setReject('Temporary processing failure');
    }
  }
};

/**
 * Durable Object using the modern Hibernation API.
 */
export class EmailNotifierDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const message = await request.text();
      this.ctx.getWebSockets().forEach((ws) => {
        try {
          ws.send(message);
        } catch (e) {
          // Ignore disconnected clients
        }
      });
      return new Response('Broadcasted', { status: 200 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {}
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) { ws.close(code, reason); }
  webSocketError(ws: WebSocket, error: unknown) { console.error('WebSocket Error:', error); }
}
