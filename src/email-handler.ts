// ============================================================
// email-handler.ts – Parses and stores incoming emails
// ============================================================

import PostalMime from 'postal-mime';
import type { Env, NotifyKV } from './types';
import { streamToArrayBuffer, headersToRecord } from './utils';

const TTL = 600; // 10 minutes

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const inboxEmail = message.to.toLowerCase().trim();
  const now = Date.now();

  // ── 1. Verify active session ──────────────────────────────
  const session = await env.TEMPMAIL_DB
    .prepare('SELECT * FROM sessions WHERE email = ? AND expires_at > ?')
    .bind(inboxEmail, now)
    .first<{ id: string; token: string }>();

  if (!session) {
    // No active inbox → reject permanently so sender gets an NDR
    message.setReject('Mailbox does not exist or has expired');
    return;
  }

  // ── 2. Parse MIME ─────────────────────────────────────────
  const rawBuffer = await streamToArrayBuffer(message.raw);
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBuffer);

  const emailId = crypto.randomUUID();

  // Gather headers (safe subset)
  const rawHeaders = JSON.stringify(headersToRecord(message.headers));

  // ── 3. Persist email in D1 ────────────────────────────────
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

  // ── 4. Process attachments → R2 ───────────────────────────
  const attachments = parsed.attachments ?? [];
  const attachBatch: D1PreparedStatement[] = [];

  for (const att of attachments) {
    if (!att.content || att.content.byteLength === 0) continue;

    const attId  = crypto.randomUUID();
    const fname  = att.filename ?? 'attachment';
    const mime   = att.mimeType ?? 'application/octet-stream';
    const r2Key  = `attachments/${emailId}/${attId}/${fname}`;

    // Upload binary to R2
    ctx.waitUntil(
      env.TEMPMAIL_ATTACHMENTS.put(r2Key, att.content, {
        httpMetadata: {
          contentType: mime,
          contentDisposition: `attachment; filename="${fname}"`,
        },
        customMetadata: {
          emailId,
          inboxEmail,
          filename: fname,
        },
        // Auto-delete in 10 min + 60s grace
        // Note: R2 doesn't have native TTL but we handle cleanup via scheduled worker
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

  // ── 5. Update KV for real-time polling ───────────────────
  const kvKey = `notify:${inboxEmail}`;
  const prev  = await env.TEMPMAIL_KV.get<NotifyKV>(kvKey, 'json');
  const next: NotifyKV = {
    count:      (prev?.count ?? 0) + 1,
    last_id:    emailId,
    updated_at: now,
  };
  await env.TEMPMAIL_KV.put(kvKey, JSON.stringify(next), {
    expirationTtl: TTL + 60, // slight grace over session TTL
  });
}
