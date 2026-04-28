import type { Env } from './types';

export async function handleScheduled(env: Env): Promise<void> {
  const now = Date.now();

  // 1. Identity expired entries
  const expired = await env.TEMPMAIL_DB
    .prepare('SELECT email FROM sessions WHERE expires_at < ?')
    .bind(now)
    .all<{ email: string }>();

  if (!expired.results || expired.results.length === 0) return;

  const emailsArr = expired.results.map(r => `'${r.email}'`).join(',');

  // 2. Explicit Batched Deep Clean (Edge-Safe Cascade)
  // KV physical blobs naturally expire via their 24h Edge TTL
  try {
    await env.TEMPMAIL_DB.batch([
      env.TEMPMAIL_DB.prepare(`DELETE FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE inbox_email IN (${emailsArr}))`),
      env.TEMPMAIL_DB.prepare(`DELETE FROM emails WHERE inbox_email IN (${emailsArr})`),
      env.TEMPMAIL_DB.prepare(`DELETE FROM sessions WHERE email IN (${emailsArr})`)
    ]);
    console.log(`[cleanup] Swept ${expired.results.length} expired session records deterministically.`);
  } catch (error) {
    console.error(`[cleanup] Batch deletion failed:`, error);
  }
}
