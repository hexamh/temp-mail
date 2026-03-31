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

// Native URLPatterns for clean, performant routing
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

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (method === 'POST' && new URLPattern({ pathname: '/inbox/create' }).test(url)) {
    return createInbox(request, env);
  }

  if (method === 'GET' && new URLPattern({ pathname: '/domains' }).test(url)) {
    return getDomains(env);
  }

  if (method === 'GET' && new URLPattern({ pathname: '/health' }).test(url)) {
    return jsonResponse({ ok: true, ts: Date.now() });
  }

  // Dynamic Routes
  let match;

  if (method === 'GET' && (match = routes.attachment.exec(url))) {
    return getAttachment(request, match.pathname.groups.token!, match.pathname.groups.attachId!, env, ctx);
  }

  if (method === 'GET' && (match = routes.email.exec(url))) {
    return getEmail(match.pathname.groups.token!, match.pathname.groups.emailId!, env);
  }

  if (method === 'DELETE' && (match = routes.email.exec(url))) {
    return deleteEmail(match.pathname.groups.token!, match.pathname.groups.emailId!, env);
  }

  if (method === 'GET' && (match = routes.stream.exec(url))) {
    return streamInbox(match.pathname.groups.token!, env);
  }

  if (method === 'GET' && (match = routes.check.exec(url))) {
    return checkInbox(match.pathname.groups.token!, env);
  }

  if (method === 'POST' && (match = routes.extend.exec(url))) {
    return extendInbox(match.pathname.groups.token!, env);
  }

  if (method === 'GET' && (match = routes.inbox.exec(url))) {
    return getInbox(match.pathname.groups.token!, env);
  }

  if (method === 'DELETE' && (match = routes.inbox.exec(url))) {
    return deleteInbox(match.pathname.groups.token!, env);
  }

  return errorResponse('Not found', 404);
}

// ... [Keep getTTL, getAllowedDomains, getSession, createInbox, getInbox, checkInbox, streamInbox, getEmail, deleteEmail exactly the same as original logic] ...

// ─────────────────────────────────────────────────────────────
// GET /inbox/:token/attachment/:attachId  →  stream file from R2 via Cache API
// ─────────────────────────────────────────────────────────────
async function getAttachment(
  request: Request,
  token: string,
  attachId: string,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!isValidUUID(attachId)) return errorResponse('Invalid attachment ID', 400);

  // 1. Check Edge Cache first
  const cacheUrl = new URL(request.url);
  const cacheKey = new Request(cacheUrl.toString(), request);
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);

  if (cachedResponse) {
    return cachedResponse;
  }

  // 2. Validate Session & Ownership
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const att = await env.TEMPMAIL_DB
    .prepare(`
      SELECT a.* FROM attachments a
      JOIN emails e ON e.id = a.email_id
      WHERE a.id = ? AND e.inbox_email = ?
    `)
    .bind(attachId, session.email)
    .first<AttachmentRow>();

  if (!att) return errorResponse('Attachment not found', 404);

  // 3. Fetch from R2
  const object = await env.TEMPMAIL_ATTACHMENTS.get(att.r2_key);
  if (!object) return errorResponse('Attachment file not found', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Length', att.size.toString());
  headers.set('Content-Disposition', `attachment; filename="${att.filename}"`);
  headers.set('Cache-Control', 'public, max-age=604800'); // Cache for 7 days
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));

  const response = new Response(object.body, { headers });

  // 4. Store in Cache for future requests
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

// ... [Keep extendInbox, deleteInbox, getDomains the same] ...
