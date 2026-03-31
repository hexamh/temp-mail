import type {
  Env, SessionRow, EmailRow, AttachmentRow,
  CreateInboxResponse, InboxResponse, EmailDetail,
  PollResponse, EmailSummary, AttachmentMeta,
} from './types';
import {
  jsonResponse, errorResponse,
  randomAlpha, buildSnippet, isValidUUID, CORS_HEADERS,
} from './utils';

// Default 10 min TTL
const DEFAULT_TTL = 600;

// ─────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────
export async function handleFetch(
  request: Request,
  env: Env
): Promise<Response> {
  const url    = new URL(request.url);
  const path   = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── POST /inbox/create ──────────────────────────────────
  if (method === 'POST' && path === '/inbox/create') {
    return createInbox(request, env);
  }

  // ── GET /inbox/:token ───────────────────────────────────
  const inboxRE = /^\/inbox\/([^/]+)$/;
  if (method === 'GET' && inboxRE.test(path)) {
    return getInbox(inboxRE.exec(path)![1], env);
  }

  // ── GET /inbox/:token/check (lightweight poll) ──────────
  const checkRE = /^\/inbox\/([^/]+)\/check$/;
  if (method === 'GET' && checkRE.test(path)) {
    return checkInbox(checkRE.exec(path)![1], env);
  }

  // ── GET /inbox/:token/stream (SSE real-time) ────────────
  const streamRE = /^\/inbox\/([^/]+)\/stream$/;
  if (method === 'GET' && streamRE.test(path)) {
    return streamInbox(streamRE.exec(path)![1], env);
  }

  // ── GET /inbox/:token/email/:emailId ────────────────────
  const emailRE = /^\/inbox\/([^/]+)\/email\/([^/]+)$/;
  if (method === 'GET' && emailRE.test(path)) {
    const [, token, emailId] = emailRE.exec(path)!;
    return getEmail(token, emailId, env);
  }

  // ── DELETE /inbox/:token/email/:emailId ─────────────────
  if (method === 'DELETE' && emailRE.test(path)) {
    const [, token, emailId] = emailRE.exec(path)!;
    return deleteEmail(token, emailId, env);
  }

  // ── GET /inbox/:token/attachment/:attachId ───────────────
  const attachRE = /^\/inbox\/([^/]+)\/attachment\/([^/]+)$/;
  if (method === 'GET' && attachRE.test(path)) {
    const [, token, attachId] = attachRE.exec(path)!;
    return getAttachment(token, attachId, env);
  }

  // ── POST /inbox/:token/extend ───────────────────────────
  const extendRE = /^\/inbox\/([^/]+)\/extend$/;
  if (method === 'POST' && extendRE.test(path)) {
    return extendInbox(extendRE.exec(path)![1], env);
  }

  // ── DELETE /inbox/:token ────────────────────────────────
  if (method === 'DELETE' && inboxRE.test(path)) {
    return deleteInbox(inboxRE.exec(path)![1], env);
  }

  // ── GET /domains ────────────────────────────────────────
  if (method === 'GET' && path === '/domains') {
    return getDomains(env);
  }

  // ── Healthcheck ─────────────────────────────────────────
  if (method === 'GET' && path === '/health') {
    return jsonResponse({ ok: true, ts: Date.now() });
  }

  return errorResponse('Not found', 404);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function getTTL(env: Env): number {
  return parseInt(env.INBOX_TTL_SECONDS ?? `${DEFAULT_TTL}`, 10) || DEFAULT_TTL;
}

function getAllowedDomains(env: Env): string[] {
  return (env.ALLOWED_DOMAINS ?? 'mail.drkingbd.cc')
    .split(',')
    .map(d => d.trim())
    .filter(Boolean);
}

/** Validate token and return live session or null */
async function getSession(
  token: string,
  env: Env
): Promise<SessionRow | null> {
  if (!token || token.length > 64) return null;
  const session = await env.TEMPMAIL_DB
    .prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
    .bind(token, Date.now())
    .first<SessionRow>();
  return session ?? null;
}

// ─────────────────────────────────────────────────────────────
// POST /inbox/create
// Body: { "domain"?: "mail.drkingbd.cc" | "drkingbd.cc" }
// ─────────────────────────────────────────────────────────────
async function createInbox(request: Request, env: Env): Promise<Response> {
  const allowed = getAllowedDomains(env);
  const ttl     = getTTL(env);
  const now     = Date.now();

  // Parse optional body
  let domain = allowed[0]; // default to first
  try {
    const body = await request.json<{ domain?: string }>();
    if (body.domain && allowed.includes(body.domain)) {
      domain = body.domain;
    }
  } catch { /* no body or invalid JSON – use default */ }

  // Generate unique address
  let email = '';
  let attempts = 0;
  while (attempts < 5) {
    const user = randomAlpha(10);
    const candidate = `${user}@${domain}`;
    const existing = await env.TEMPMAIL_DB
      .prepare('SELECT id FROM sessions WHERE email = ?')
      .bind(candidate)
      .first();
    if (!existing) { email = candidate; break; }
    attempts++;
  }
  if (!email) return errorResponse('Could not generate unique address, retry', 500);

  const id        = crypto.randomUUID();
  const token     = crypto.randomUUID();
  const expiresAt = now + ttl * 1000;

  // Insert into D1
  await env.TEMPMAIL_DB
    .prepare(`
      INSERT INTO sessions (id, email, token, domain, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(id, email, token, domain, now, expiresAt)
    .run();

  // Mirror into KV for email-handler fast lookups
  const kvSessionKey = `session:${token}`;
  await env.TEMPMAIL_KV.put(kvSessionKey, JSON.stringify({
    email, token, domain, created_at: now, expires_at: expiresAt,
  }), { expirationTtl: ttl + 60 });

  const response: CreateInboxResponse = {
    success:     true,
    token,
    email,
    domain,
    created_at:  now,
    expires_at:  expiresAt,
    ttl_seconds: ttl,
  };

  return jsonResponse(response, 201);
}

// ─────────────────────────────────────────────────────────────
// GET /inbox/:token  →  list all emails
// ─────────────────────────────────────────────────────────────
async function getInbox(token: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  // Fetch emails
  const emailRows = await env.TEMPMAIL_DB
    .prepare(`
      SELECT e.*,
             (SELECT COUNT(*) FROM attachments a WHERE a.email_id = e.id) AS att_count
      FROM emails e
      WHERE e.inbox_email = ?
      ORDER BY e.received_at DESC
    `)
    .bind(session.email)
    .all<EmailRow & { att_count: number }>();

  const emails: EmailSummary[] = (emailRows.results ?? []).map(row => ({
    id:              row.id,
    from_address:    row.from_address,
    from_name:       row.from_name,
    subject:         row.subject,
    received_at:     row.received_at,
    is_read:         row.is_read === 1,
    size:            row.size,
    has_attachments: row.att_count > 0,
    snippet:         buildSnippet(row.body_text, row.body_html),
  }));

  const now     = Date.now();
  const response: InboxResponse = {
    success:       true,
    token,
    email:         session.email,
    expires_at:    session.expires_at,
    ttl_remaining: Math.max(0, Math.floor((session.expires_at - now) / 1000)),
    emails,
    total:         emails.length,
  };

  return jsonResponse(response);
}

// ─────────────────────────────────────────────────────────────
// GET /inbox/:token/check  →  lightweight new-mail poll
// ─────────────────────────────────────────────────────────────
async function checkInbox(token: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const kvKey  = `notify:${session.email}`;
  const notify = await env.TEMPMAIL_KV.get<{
    count: number; last_id: string; updated_at: number;
  }>(kvKey, 'json');

  const now     = Date.now();
  const resp: PollResponse = {
    has_new:       notify !== null,
    count:         notify?.count  ?? 0,
    last_id:       notify?.last_id ?? null,
    updated_at:    notify?.updated_at ?? null,
    expires_at:    session.expires_at,
    ttl_remaining: Math.max(0, Math.floor((session.expires_at - now) / 1000)),
  };

  return jsonResponse(resp);
}

// ─────────────────────────────────────────────────────────────
// GET /inbox/:token/stream  →  SSE real-time updates
// ─────────────────────────────────────────────────────────────
async function streamInbox(token: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const write = (data: string) =>
    writer.write(encoder.encode(data));

  const sendEvent = (event: string, data: unknown) =>
    write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const kvKey  = `notify:${session.email}`;
  let lastCount = 0;
  const now = Date.now();

  // Initial state
  const current = await env.TEMPMAIL_KV.get<{ count: number }>(kvKey, 'json');
  lastCount = current?.count ?? 0;

  // Stream runs for up to 25 seconds, then client must reconnect
  // (Workers have a 30s wall-clock limit on streaming responses)
  const MAX_DURATION_MS = 25_000;
  const POLL_INTERVAL_MS = 2_000;
  const start = Date.now();

  (async () => {
    try {
      // Send initial ping
      await sendEvent('connected', {
        email: session.email,
        expires_at: session.expires_at,
        ttl_remaining: Math.max(0, Math.floor((session.expires_at - now) / 1000)),
      });

      while (Date.now() - start < MAX_DURATION_MS) {
        await sleep(POLL_INTERVAL_MS);

        // Check session still valid
        if (Date.now() > session.expires_at) {
          await sendEvent('expired', { message: 'Inbox expired' });
          break;
        }

        const notify = await env.TEMPMAIL_KV.get<{
          count: number; last_id: string; updated_at: number;
        }>(kvKey, 'json');

        const newCount = notify?.count ?? 0;
        if (newCount > lastCount) {
          lastCount = newCount;
          await sendEvent('new_email', {
            count:      newCount,
            last_id:    notify!.last_id,
            updated_at: notify!.updated_at,
          });
        } else {
          // Keepalive comment
          await write(`: ping\n\n`);
        }
      }

      // Tell client to reconnect
      await sendEvent('reconnect', { after_ms: 0 });
    } catch (_) {
      // Client disconnected
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS_HEADERS,
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────
// GET /inbox/:token/email/:emailId  →  full email detail
// ─────────────────────────────────────────────────────────────
async function getEmail(token: string, emailId: string, env: Env): Promise<Response> {
  if (!isValidUUID(emailId)) return errorResponse('Invalid email ID', 400);

  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const row = await env.TEMPMAIL_DB
    .prepare('SELECT * FROM emails WHERE id = ? AND inbox_email = ?')
    .bind(emailId, session.email)
    .first<EmailRow>();

  if (!row) return errorResponse('Email not found', 404);

  // Mark as read
  await env.TEMPMAIL_DB
    .prepare('UPDATE emails SET is_read = 1 WHERE id = ?')
    .bind(emailId)
    .run();

  // Fetch attachments
  const attRows = await env.TEMPMAIL_DB
    .prepare('SELECT * FROM attachments WHERE email_id = ?')
    .bind(emailId)
    .all<AttachmentRow>();

  const baseUrl = `https://tempmail.drkingbd.cc`; // adjust to your worker route
  const attachments: AttachmentMeta[] = (attRows.results ?? []).map(a => ({
    id:           a.id,
    filename:     a.filename,
    content_type: a.content_type,
    size:         a.size,
    download_url: `${baseUrl}/inbox/${token}/attachment/${a.id}`,
  }));

  const detail: EmailDetail = {
    id:           row.id,
    inbox_email:  row.inbox_email,
    from_address: row.from_address,
    from_name:    row.from_name,
    reply_to:     row.reply_to,
    subject:      row.subject,
    body_text:    row.body_text,
    body_html:    row.body_html,
    received_at:  row.received_at,
    is_read:      true,
    size:         row.size,
    attachments,
  };

  return jsonResponse({ success: true, email: detail });
}

// ─────────────────────────────────────────────────────────────
// DELETE /inbox/:token/email/:emailId
// ─────────────────────────────────────────────────────────────
async function deleteEmail(token: string, emailId: string, env: Env): Promise<Response> {
  if (!isValidUUID(emailId)) return errorResponse('Invalid email ID', 400);

  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  // Get attachment R2 keys first
  const atts = await env.TEMPMAIL_DB
    .prepare('SELECT r2_key FROM attachments WHERE email_id = ?')
    .bind(emailId)
    .all<{ r2_key: string }>();

  // Delete from D1 (CASCADE handles attachments table)
  const result = await env.TEMPMAIL_DB
    .prepare('DELETE FROM emails WHERE id = ? AND inbox_email = ?')
    .bind(emailId, session.email)
    .run();

  if (result.meta.changes === 0) return errorResponse('Email not found', 404);

  // Delete R2 objects
  for (const att of (atts.results ?? [])) {
    await env.TEMPMAIL_ATTACHMENTS.delete(att.r2_key);
  }

  return jsonResponse({ success: true, deleted: emailId });
}

// ─────────────────────────────────────────────────────────────
// GET /inbox/:token/attachment/:attachId  →  stream file from R2
// ─────────────────────────────────────────────────────────────
async function getAttachment(
  token: string,
  attachId: string,
  env: Env
): Promise<Response> {
  if (!isValidUUID(attachId)) return errorResponse('Invalid attachment ID', 400);

  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  // Verify ownership
  const att = await env.TEMPMAIL_DB
    .prepare(`
      SELECT a.* FROM attachments a
      JOIN emails e ON e.id = a.email_id
      WHERE a.id = ? AND e.inbox_email = ?
    `)
    .bind(attachId, session.email)
    .first<AttachmentRow>();

  if (!att) return errorResponse('Attachment not found', 404);

  // Stream from R2
  const object = await env.TEMPMAIL_ATTACHMENTS.get(att.r2_key);
  if (!object) return errorResponse('Attachment file not found', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Length', att.size.toString());
  headers.set('Content-Disposition', `attachment; filename="${att.filename}"`);
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(object.body, { headers });
}

// ─────────────────────────────────────────────────────────────
// POST /inbox/:token/extend  →  extend inbox by another 10 min
// ─────────────────────────────────────────────────────────────
async function extendInbox(token: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const ttl        = getTTL(env);
  const now        = Date.now();
  const newExpires = now + ttl * 1000;

  await env.TEMPMAIL_DB
    .prepare('UPDATE sessions SET expires_at = ? WHERE token = ?')
    .bind(newExpires, token)
    .run();

  // Refresh KV
  const kvKey = `session:${token}`;
  await env.TEMPMAIL_KV.put(kvKey, JSON.stringify({
    ...session,
    expires_at: newExpires,
  }), { expirationTtl: ttl + 60 });

  return jsonResponse({
    success: true,
    expires_at: newExpires,
    ttl_seconds: ttl,
    ttl_remaining: ttl,
  });
}

// ─────────────────────────────────────────────────────────────
// DELETE /inbox/:token  →  purge session + all emails
// ─────────────────────────────────────────────────────────────
async function deleteInbox(token: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  // Get all attachment R2 keys
  const atts = await env.TEMPMAIL_DB
    .prepare(`
      SELECT a.r2_key FROM attachments a
      JOIN emails e ON e.id = a.email_id
      WHERE e.inbox_email = ?
    `)
    .bind(session.email)
    .all<{ r2_key: string }>();

  // Delete from D1 (CASCADE handles emails + attachments)
  await env.TEMPMAIL_DB
    .prepare('DELETE FROM sessions WHERE token = ?')
    .bind(token)
    .run();

  // Delete R2 files
  for (const att of (atts.results ?? [])) {
    await env.TEMPMAIL_ATTACHMENTS.delete(att.r2_key);
  }

  // Clean KV
  await Promise.all([
    env.TEMPMAIL_KV.delete(`session:${token}`),
    env.TEMPMAIL_KV.delete(`notify:${session.email}`),
  ]);

  return jsonResponse({ success: true, deleted: session.email });
}

// ─────────────────────────────────────────────────────────────
// GET /domains  →  list available email domains
// ─────────────────────────────────────────────────────────────
async function getDomains(env: Env): Promise<Response> {
  return jsonResponse({
    success: true,
    domains: getAllowedDomains(env),
    default: getAllowedDomains(env)[0],
  });
}
