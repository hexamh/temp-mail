// ─────────────────────────────────────────────────────────────
// GET /inbox/:token/attachment/:attachId  →  Stream file from KV via Edge Cache
// ─────────────────────────────────────────────────────────────
async function getAttachment(
  request: Request,
  token: string,
  attachId: string,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!isValidUUID(attachId)) return errorResponse('Invalid attachment ID', 400);

  const cacheUrl = new URL(request.url);
  const cacheKey = new Request(cacheUrl.toString(), request);
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);

  if (cachedResponse) {
    return cachedResponse;
  }

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

  // Retrieve optimal stream directly from Edge KV
  const stream = await env.TEMPMAIL_KV.get(att.kv_key, 'stream');
  if (!stream) return errorResponse('Attachment expired or purged from edge', 404);

  const headers = new Headers();
  headers.set('Content-Type', att.content_type);
  headers.set('Content-Length', att.size.toString());
  headers.set('Content-Disposition', `attachment; filename="${att.filename}"`);
  headers.set('Cache-Control', 'public, max-age=604800'); // Cache for 7 days at edge
  
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));

  const response = new Response(stream, { headers });
  
  // Asynchronously seed edge cache
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

// ─────────────────────────────────────────────────────────────
// DELETE /inbox/:token/email/:emailId
// ─────────────────────────────────────────────────────────────
async function deleteEmail(token: string, emailId: string, env: Env): Promise<Response> {
  if (!isValidUUID(emailId)) return errorResponse('Invalid email ID', 400);

  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  const atts = await env.TEMPMAIL_DB
    .prepare('SELECT kv_key FROM attachments WHERE email_id = ?')
    .bind(emailId)
    .all<{ kv_key: string }>();

  const result = await env.TEMPMAIL_DB
    .prepare('DELETE FROM emails WHERE id = ? AND inbox_email = ?')
    .bind(emailId, session.email)
    .run();

  if (result.meta.changes === 0) return errorResponse('Email not found', 404);

  // Fire-and-forget explicit KV purge (though TTL handles this automatically)
  for (const att of (atts.results ?? [])) {
    await env.TEMPMAIL_KV.delete(att.kv_key);
  }

  return jsonResponse({ success: true, deleted: emailId });
}

// ─────────────────────────────────────────────────────────────
// DELETE /inbox/:token  →  purge session + all emails
// ─────────────────────────────────────────────────────────────
async function deleteInbox(token: string, env: Env): Promise<Response> {
  const session = await getSession(token, env);
  if (!session) return errorResponse('Inbox not found or expired', 404);

  // Due to D1 CASCADE, this removes the emails and attachments table references
  await env.TEMPMAIL_DB
    .prepare('DELETE FROM sessions WHERE token = ?')
    .bind(token)
    .run();

  // Purging session data aggressively from KV. 
  // We allow attachment blobs to die naturally via their KV TTL to save Worker execution time.
  await Promise.all([
    env.TEMPMAIL_KV.delete(`session:${token}`),
    env.TEMPMAIL_KV.delete(`notify:${session.email}`),
  ]);

  return jsonResponse({ success: true, deleted: session.email });
}
