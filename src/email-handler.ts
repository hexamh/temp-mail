import PostalMime from 'postal-mime';
import type { Env, NotifyKV } from './types';
import { headersToRecord } from './utils';

// Constants strictly mapped to edge performance limits
const MAX_EMAIL_SIZE_BYTES = 15 * 1024 * 1024; // 15MB API Guard
const DEFAULT_TTL = 600;

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const inboxEmail = message.to.toLowerCase().trim();
  const now = Date.now();

  if (message.rawSize > MAX_EMAIL_SIZE_BYTES) {
    message.setReject(`Message exceeds the maximum allowed size of ${MAX_EMAIL_SIZE_BYTES / (1024 * 1024)}MB`);
    return;
  }

  const session = await env.TEMPMAIL_DB
    .prepare('SELECT id, token, expires_at FROM sessions WHERE email = ? AND expires_at > ?')
    .bind(inboxEmail, now)
    .first<{ id: string; token: string; expires_at: number }>();

  if (!session) {
    message.setReject('Mailbox does not exist or has expired');
    return;
  }

  const emailId = crypto.randomUUID();
  const rawHeaders = JSON.stringify(headersToRecord(message.headers));
  
  const fallbackSubject = message.headers.get('subject') ?? '(no subject)';
  const fallbackFrom = message.headers.get('from') ?? message.from ?? '';

  let parsed;
  try {
    const parser = new PostalMime();
    const response = new Response(message.raw);
    parsed = await parser.parse(await response.arrayBuffer()); 
  } catch (error) {
    console.error(`MIME parse failure for ${emailId}:`, error);
    message.setReject('Unparseable MIME content');
    return;
  }

  await env.TEMPMAIL_DB
    .prepare(`
      INSERT INTO emails
        (id, inbox_email, from_address, from_name, reply_to,
         subject, body_text, body_html, raw_headers, received_at, size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      emailId,
      inboxEmail,
      parsed.from?.address ?? fallbackFrom,
      parsed.from?.name   ?? '',
      parsed.replyTo?.[0]?.address ?? '',
      parsed.subject      ?? fallbackSubject,
      parsed.text         ?? '',
      parsed.html         ?? '',
      rawHeaders,
      now,
      message.rawSize
    )
    .run();

  const attachments = parsed.attachments ?? [];
  const attachBatch: D1PreparedStatement[] = [];
  
  // Calculate exact TTL dynamically from session state to ensure synchronization
  const ttlRemainingSeconds = Math.max(60, Math.ceil((session.expires_at - now) / 1000) + 60);

  for (const att of attachments) {
    if (!att.content || att.content.byteLength === 0) continue;

    const attId  = crypto.randomUUID();
    const fname  = att.filename ?? 'attachment';
    const mime   = att.mimeType ?? 'application/octet-stream';
    const kvKey  = `attachment:${emailId}:${attId}`;

    // Offload high-latency storage operations to background
    ctx.waitUntil(
      env.TEMPMAIL_KV.put(kvKey, att.content, { expirationTtl: ttlRemainingSeconds })
    );

    attachBatch.push(
      env.TEMPMAIL_DB
        .prepare(`
          INSERT INTO attachments (id, email_id, filename, content_type, size, kv_key)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(attId, emailId, fname, mime, att.content.byteLength, kvKey)
    );
  }

  if (attachBatch.length > 0) {
    await env.TEMPMAIL_DB.batch(attachBatch);
  }

  ctx.waitUntil((async () => {
    const notifyKey = `notify:${inboxEmail}`;
    const prev  = await env.TEMPMAIL_KV.get<NotifyKV>(notifyKey, 'json');
    const next: NotifyKV = {
      count:      (prev?.count ?? 0) + 1,
      last_id:    emailId,
      updated_at: now,
    };
    await env.TEMPMAIL_KV.put(notifyKey, JSON.stringify(next), {
      expirationTtl: ttlRemainingSeconds,
    });
  })());
}
