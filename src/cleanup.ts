import type { Env } from './types';

export async function handleScheduled(env: Env): Promise<void> {
  const now = Date.now();

  // Singular D1 sweep. 
  // D1 CASCADE handles emails/attachments relational data natively.
  // KV handles physical blob expiration automatically via its edge TTL engine.
  const result = await env.TEMPMAIL_DB
    .prepare('DELETE FROM sessions WHERE expires_at < ?')
    .bind(now)
    .run();

  if (result.meta.changes > 0) {
    console.log(`[cleanup] Swept ${result.meta.changes} expired session records from relational store.`);
  }
}
