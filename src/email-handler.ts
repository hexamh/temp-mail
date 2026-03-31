import PostalMime from 'postal-mime';
import type { Env, NotifyKV } from './types';
import { streamToArrayBuffer, headersToRecord } from './utils';

const TTL = 600; // 10 minutes
const MAX_EMAIL_SIZE = 25 * 1024 * 1024; // 25MB safety limit

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const inboxEmail = message.to.toLowerCase().trim();
  const now = Date.now();

  // 1. Guard against memory exhaustion
  if (message.rawSize && message.rawSize > MAX_EMAIL_SIZE) {
    message.setReject('Email exceeds the maximum allowed size of 25MB.');
    return;
  }

  // 2. Verify active session
  const session = await env.TEMPMAIL_DB
    .prepare('SELECT id, token FROM sessions WHERE email = ? AND expires_at > ?')
    .bind(inboxEmail, now)
    .first<{ id: string; token: string }>();

  if (!session) {
    message.setReject('Mailbox does not exist or has expired.');
    return;
  }

  // 3. Parse MIME safely within limits
  const rawBuffer = await streamToArrayBuffer(message.raw);
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBuffer);

  const emailId = crypto.randomUUID();
  const rawHeaders = JSON.stringify(headersToRecord(message.headers));

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
      parsed.from?.address ?? message.from ?? '',
      parsed.from?.name   ?? '',
      parsed.replyTo?.[0]?.address ?? '',
      parsed.subject      ?? '(no subject)',
      parsed.text         ?? '',
      parsed.html         ?? '',
      rawHeaders,
      now,
      message.rawSize ?? 0
    )
    .run();

  // 5. Process attachments to R2 (Using waitUntil for parallel uploads)
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

  // 6. Update KV asynchronously to avoid delaying the MTA response
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
