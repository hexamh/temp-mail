import PostalMime from 'postal-mime';
import type { Env, NotifyKV } from './types';
import { headersToRecord } from './utils';

const TTL = 600; // 10 minutes
const MAX_EMAIL_SIZE_BYTES = 15 * 1024 * 1024; // 15MB safe limit for Worker memory

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const inboxEmail = message.to.toLowerCase().trim();
  const now = Date.now();

  // 1. Pre-emptive API Size Guard
  if (message.rawSize > MAX_EMAIL_SIZE_BYTES) {
    message.setReject(`Message exceeds the maximum allowed size of ${MAX_EMAIL_SIZE_BYTES / (1024 * 1024)}MB`);
    return;
  }

  // 2. Verify active session
  const session = await env.TEMPMAIL_DB
    .prepare('SELECT id, token FROM sessions WHERE email = ? AND expires_at > ?')
    .bind(inboxEmail, now)
    .first<{ id: string; token: string }>();

  if (!session) {
    message.setReject('Mailbox does not exist or has expired');
    return;
  }

  const emailId = crypto.randomUUID();
  const rawHeaders = JSON.stringify(headersToRecord(message.headers));
  
  // Extract fast-access data directly from native API Headers
  const fallbackSubject = message.headers.get('subject') ?? '(no subject)';
  const fallbackFrom = message.headers.get('from') ?? message.from ?? '';

  let parsed;
  try {
    // 3. Efficient stream parsing (avoiding manual ArrayBuffer conversion if possible)
    const parser = new PostalMime();
    // Wrap the raw ReadableStream in a Response to allow PostalMime to stream it
    const response = new Response(message.raw);
    parsed = await parser.parse(await response.arrayBuffer()); 
  } catch (error) {
    console.error(`Failed to parse email ${emailId}:`, error);
    message.setReject('Unparseable MIME content');
    return;
  }

  // 4. Persist email in D1
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

  // 5. Process attachments to R2 (Offloaded to background via ctx.waitUntil)
  const attachments = parsed.attachments ?? [];
  const attachBatch: D1PreparedStatement[] = [];

  for (const att of attachments) {
    if (!att.content || att.content.byteLength === 0) continue;

    const attId  = crypto.randomUUID();
    const fname  = att.filename ?? 'attachment';
    const mime   = att.mimeType ?? 'application/octet-stream';
    const r2Key  = `attachments/${emailId}/${attId}/${fname}`;

    ctx.waitUntil(
      env.TEMPMAIL_ATTACHMENTS.put(r2Key, att.content, {
        httpMetadata: {
          contentType: mime,
          contentDisposition: `attachment; filename="${fname}"`,
        },
        customMetadata: { emailId, inboxEmail, filename: fname },
      })
    );

    attachBatch.push(
      env.TEMPMAIL_DB
        .prepare(`
          INSERT INTO attachments (id, email_id, filename, content_type, size, r2_key)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(attId, emailId, fname, mime, att.content.byteLength, r2Key)
    );
  }

  if (attachBatch.length > 0) {
    await env.TEMPMAIL_DB.batch(attachBatch);
  }

  // 6. Update KV asynchronously to avoid delaying the SMTP OK response
  ctx.waitUntil((async () => {
    const kvKey = `notify:${inboxEmail}`;
    const prev  = await env.TEMPMAIL_KV.get<NotifyKV>(kvKey, 'json');
    const next: NotifyKV = {
      count:      (prev?.count ?? 0) + 1,
      last_id:    emailId,
      updated_at: now,
    };
    await env.TEMPMAIL_KV.put(kvKey, JSON.stringify(next), {
      expirationTtl: TTL + 60,
    });
  })());
}
