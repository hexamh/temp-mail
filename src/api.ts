import type {
  Env, SessionRow, EmailRow, AttachmentRow,
  CreateInboxResponse, InboxResponse, EmailDetail,
  PollResponse, EmailSummary, AttachmentMeta,
} from './types';
import {
  jsonResponse, errorResponse,
  randomAlpha, buildSnippet, isValidUUID, CORS_HEADERS,
} from './utils';

const DEFAULT_TTL = 600;

const routes = {
  inbox: new URLPattern({ pathname: '/inbox/:token' }),
  check: new URLPattern({ pathname: '/inbox/:token/check' }),
  stream: new URLPattern({ pathname: '/inbox/:token/stream' }),
  email: new URLPattern({ pathname: '/inbox/:token/email/:emailId' }),
  attachment: new URLPattern({ pathname: '/inbox/:token/attachment/:attachId' }),
  extend: new URLPattern({ pathname: '/inbox/:token/extend' }),
};

export async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const method = request.method.toUpperCase();
  const url = request.url;
  const parsedUrl = new URL(url);

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    if (method === 'GET' && parsedUrl.pathname === '/') return getRootPromotion(request);
    if (method === 'POST' && new URLPattern({ pathname: '/inbox/create' }).test(url)) return createInbox(request, env);
    if (method === 'GET' && new URLPattern({ pathname: '/domains' }).test(url)) return getDomains(env);
    if (method === 'GET' && new URLPattern({ pathname: '/health' }).test(url)) return jsonResponse({ ok: true, ts: Date.now() });

    let match;

    if (method === 'GET' && (match = routes.attachment.exec(url))) {
      return await getAttachment(request, match.pathname.groups.token!, match.pathname.groups.attachId!, env, ctx);
    }
    if (method === 'GET' && (match = routes.email.exec(url))) {
      return await getEmail(request, match.pathname.groups.token!, match.pathname.groups.emailId!, env);
    }
    if (method === 'DELETE' && (match = routes.email.exec(url))) {
      return await deleteEmail(match.pathname.groups.token!, match.pathname.groups.emailId!, env);
    }
    if (method === 'GET' && (match = routes.stream.exec(url))) {
      return await streamInbox(match.pathname.groups.token!, env);
    }
    if (method === 'GET' && (match = routes.check.exec(url))) {
      return await checkInbox(match.pathname.groups.token!, env);
    }
    if (method === 'POST' && (match = routes.extend.exec(url))) {
      return await extendInbox(match.pathname.groups.token!, env);
    }
    if (method === 'GET' && (match = routes.inbox.exec(url))) {
      return await getInbox(match.pathname.groups.token!, env);
    }
    if (method === 'DELETE' && (match = routes.inbox.exec(url))) {
      return await deleteInbox(match.pathname.groups.token!, env);
    }

    return errorResponse('Not found', 404);
  } catch (err) {
    console.error('API Error:', err);
    return errorResponse('Internal Server Error', 500);
  }
}

function getRootPromotion(request: Request): Response {
  const acceptHeader = request.headers.get('Accept') || '';

  if (acceptHeader.includes('text/html')) {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TempMail API - Serverless Edge</title>
      <style>
        body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
        .container { padding: 2rem; border-radius: 16px; background: #1e293b; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border: 1px solid #334155; max-width: 600px; width: 90%; }
        h1 { font-size: 2.2rem; margin-bottom: 0.5rem; background: -webkit-linear-gradient(45deg, #60a5fa, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        p { font-size: 1.1rem; color: #94a3b8; line-height: 1.6; margin-bottom: 2rem; }
        a.btn { display: inline-flex; align-items: center; gap: 8px; background: #3b82f6; color: white; padding: 12px 28px; border-radius: 9999px; text-decoration: none; font-weight: 600; transition: all 0.2s; box-shadow: 0 4px 14px 0 rgba(59, 130, 246, 0.39); }
        a.btn:hover { background: #2563eb; transform: translateY(-2px); }
        .footer { margin-top: 2rem; font-size: 0.85rem; color: #475569; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>✉️ TempMail API Server</h1>
        <p>A high-performance, fully serverless temporary email service running globally on Cloudflare's Edge infrastructure.</p>
        <a href="https://t.me/drkingbd" target="_blank" rel="noopener noreferrer" class="btn">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2L2 10.5l6.5 3 2.5 8.5 3.5-5.5 4.5 4.5L21.5 2z"/></svg>
          Join our Telegram Channel
        </a>
        <div class="footer">Build reliable, disposable email workflows.</div>
      </div>
    </body>
    </html>
    `;
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...CORS_HEADERS } });
  }

  return jsonResponse({
    service: "TempMail Serverless API",
    status: "online",
    message: "Welcome to the edge-optimized temporary email API.",
    promotion: "🚀 Join our Telegram community for updates, scripts, and support!",
    telegram: "https://t.me/drkingbd",
    docs_hint: "Send a POST to /inbox/create to get started."
  });
}

function getTTL(env: Env): number { return parseInt(env.INBOX_TTL_SECONDS ?? `${DEFAULT_TTL}`, 10) || DEFAULT_TTL; }
function getAllowedDomains(env: Env): string[] { return (env.ALLOWED_DOMAINS ?? 'mail.drkingbd.cc').split(',').map(d => d.trim()).filter(Boolean); }
async function getSession(token: string, env: Env): Promise<SessionRow | null> {
  if (!token || token.length > 64) return null;
  const session = await env.TEMPMAIL_DB.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?').bind(token, Date.now()).first<SessionRow>();
  return session ?? null;
}

async function createInbox(request: Request, env: Env): Promise<Response> {
  const allowed = getAllowedDomains(env);
  const ttl     = getTTL(env);
  const now     = Date.now();

  let domain = allowed[0]; 
  try {
    const body = await request.json<{ domain?: string }>();
    if (body.domain && allowed.includes(body.domain)) domain = body.domain;
  } catch {}

  let email = '';
  for (let attempts = 0; attempts < 5; attempts++) {
    const candidate = `${randomAlpha(10)}@${domain}`;
    const existing = await env.TEMPMAIL_DB.prepare('SELECT id FROM sessions WHERE email = ?').bind(candidate).first();
    if (!existing) { email = candidate; break; }
  }
  
  if (!email) return errorResponse('Could not generate unique address, please retry', 500);

  const id        = crypto.randomUUID();
  const token     = crypto.randomUUID();
  const expiresAt = now + ttl * 1000;

  await env.TEMPMAIL_DB.prepare(`INSERT INTO sessions (id, email, token, domain, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, email, token, domain, now, expiresAt).run();
  await env.TEMPMAIL_KV.put(`session:${token}`, JSON.stringify({ email, token, domain, created_at: now, expires_at: expiresAt }), { expirationTtl: ttl + 60 });

  return jsonResponse<CreateInboxResponse>({ success: true, token, email, domain, created_at: now, expires_at: expiresAt, ttl_seconds: ttl }, 201);
}

async function getInbox(token: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const emailRows = await env.TEMPMAIL_DB
    .prepare(`SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.email_id = e.id) AS att_count FROM emails e WHERE e.inbox_email = ? ORDER BY e.received_at DESC`)
    .bind(session.email)
    .all<EmailRow & { att_count: number }>();

  const emails: EmailSummary[] = (emailRows.results ?? []).map(row => ({
    id: row.id, from_address: row.from_address, from_name: row.from_name, subject: row.subject,
    received_at: row.received_at, is_read: row.is_read === 1, size: row.size, has_attachments: row.att_count > 0, snippet: buildSnippet(row.body_text, row.body_html),
  }));

  return jsonResponse<InboxResponse>({
    success: true, token, email: session.email, expires_at: session.expires_at,
    ttl_remaining: Math.max(0, Math.floor((session.expires_at - Date.now()) / 1000)), emails, total: emails.length,
  });
}

async function checkInbox(token: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const notify = await env.TEMPMAIL_KV.get<{ count: number; last_id: string; updated_at: number; }>(`notify:${session.email}`, 'json');

  return jsonResponse<PollResponse>({
    has_new: notify !== null, count: notify?.count ?? 0, last_id: notify?.last_id ?? null, updated_at: notify?.updated_at ?? null,
    expires_at: session.expires_at, ttl_remaining: Math.max(0, Math.floor((session.expires_at - Date.now()) / 1000)),
  });
}

async function streamInbox(token: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = async (event: string, data: unknown) => { await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); };

  const kvKey = `notify:${session.email}`;
  let lastCount = (await env.TEMPMAIL_KV.get<{ count: number }>(kvKey, 'json'))?.count ?? 0;
  
  const MAX_DURATION_MS = 25_000;
  const start = Date.now();

  ctx.waitUntil((async () => {
    try {
      await sendEvent('connected', { email: session.email, expires_at: session.expires_at });
      while (Date.now() - start < MAX_DURATION_MS) {
        await new Promise(r => setTimeout(r, 2000));
        if (Date.now() > session.expires_at) { await sendEvent('expired', { message: 'Inbox expired' }); break; }
        const notify = await env.TEMPMAIL_KV.get<{ count: number; last_id: string; updated_at: number; }>(kvKey, 'json');
        const newCount = notify?.count ?? 0;
        if (newCount > lastCount) {
          lastCount = newCount;
          await sendEvent('new_email', { count: newCount, last_id: notify!.last_id, updated_at: notify!.updated_at });
        } else {
          await writer.write(encoder.encode(`: ping\n\n`));
        }
      }
      await sendEvent('reconnect', { after_ms: 0 });
    } catch (_) {} finally { await writer.close(); }
  })());

  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...CORS_HEADERS } });
}

async function getEmail(request: Request, token: string, emailId: string, env: Env): Promise<Response> {
  if (!isValidUUID(emailId)) return errorResponse('Invalid email ID', 400);

  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const row = await env.TEMPMAIL_DB.prepare('SELECT * FROM emails WHERE id = ? AND inbox_email = ?').bind(emailId, session.email).first<EmailRow>();
  if (!row) return errorResponse('Email not found', 404);

  await env.TEMPMAIL_DB.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').bind(emailId).run();

  const attRows = await env.TEMPMAIL_DB.prepare('SELECT * FROM attachments WHERE email_id = ?').bind(emailId).all<AttachmentRow>();
  
  const urlParams = new URL(request.url);
  const baseUrl = `${urlParams.protocol}//${urlParams.host}`; 

  const attachments: AttachmentMeta[] = (attRows.results ?? []).map(a => ({
    id: a.id, filename: a.filename, content_type: a.content_type, size: a.size, download_url: `${baseUrl}/inbox/${token}/attachment/${a.id}`,
  }));

  return jsonResponse({ success: true, email: { ...row, is_read: true, attachments } });
}

async function getAttachment(request: Request, token: string, attachId: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isValidUUID(attachId)) return errorResponse('Invalid attachment ID', 400);

  const cacheKey = new Request(request.url, request);
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const att = await env.TEMPMAIL_DB.prepare(`SELECT a.* FROM attachments a JOIN emails e ON e.id = a.email_id WHERE a.id = ? AND e.inbox_email = ?`).bind(attachId, session.email).first<AttachmentRow>();
  if (!att) return errorResponse('Attachment not found', 404);

  const stream = await env.TEMPMAIL_KV.get(att.kv_key, 'stream');
  if (!stream) return errorResponse('Attachment expired or purged from edge', 404);

  const headers = new Headers(CORS_HEADERS);
  headers.set('Content-Type', att.content_type);
  headers.set('Content-Length', att.size.toString());
  headers.set('Content-Disposition', `attachment; filename="${att.filename}"`);
  headers.set('Cache-Control', 'public, max-age=604800'); 

  const response = new Response(stream, { headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function deleteEmail(token: string, emailId: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const atts = await env.TEMPMAIL_DB.prepare('SELECT kv_key FROM attachments WHERE email_id = ?').bind(emailId).all<{ kv_key: string }>();
  const result = await env.TEMPMAIL_DB.prepare('DELETE FROM emails WHERE id = ? AND inbox_email = ?').bind(emailId, session.email).run();

  if (result.meta.changes === 0) return errorResponse('Email not found', 404);
  atts.results?.forEach(att => ctx.waitUntil(env.TEMPMAIL_KV.delete(att.kv_key)));
  return jsonResponse({ success: true, deleted: emailId });
}

async function deleteInbox(token: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  await env.TEMPMAIL_DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  await Promise.all([env.TEMPMAIL_KV.delete(`session:${token}`), env.TEMPMAIL_KV.delete(`notify:${session.email}`)]);

  return jsonResponse({ success: true, deleted: session.email });
}

async function extendInbox(token: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const ttl = getTTL(env);
  const newExpires = Date.now() + ttl * 1000;

  await env.TEMPMAIL_DB.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').bind(newExpires, token).run();
  await env.TEMPMAIL_KV.put(`session:${token}`, JSON.stringify({ ...session, expires_at: newExpires }), { expirationTtl: ttl + 60 });

  return jsonResponse({ success: true, expires_at: newExpires, ttl_seconds: ttl, ttl_remaining: ttl });
}

async function getDomains(env: Env): Promise<Response> {
  const domains = getAllowedDomains(env);
  return jsonResponse({ success: true, domains, default: domains[0] });
}
