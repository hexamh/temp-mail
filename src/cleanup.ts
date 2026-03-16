// ============================================================
// cleanup.ts – Scheduled Cron job to purge expired data
// ============================================================

import type { Env } from './types';

export async function handleScheduled(env: Env): Promise<void> {
  const now = Date.now();

  // 1. Get all expired sessions
  const expired = await env.TEMPMAIL_DB
    .prepare('SELECT email FROM sessions WHERE expires_at < ?')
    .bind(now)
    .all<{ email: string }>();

  const emails = (expired.results ?? []).map(r => r.email);
  if (emails.length === 0) return;

  // 2. Collect R2 keys for their attachments
  for (const inboxEmail of emails) {
    const atts = await env.TEMPMAIL_DB
      .prepare(`
        SELECT a.r2_key FROM attachments a
        JOIN emails e ON e.id = a.email_id
        WHERE e.inbox_email = ?
      `)
      .bind(inboxEmail)
      .all<{ r2_key: string }>();

    // Delete R2 objects
    for (const att of (atts.results ?? [])) {
      try {
        await env.TEMPMAIL_ATTACHMENTS.delete(att.r2_key);
      } catch {
        console.warn(`Failed to delete R2 key: ${att.r2_key}`);
      }
    }

    // Delete from D1 (CASCADE handles emails + attachments)
    await env.TEMPMAIL_DB
      .prepare('DELETE FROM sessions WHERE email = ?')
      .bind(inboxEmail)
      .run();
  }

  console.log(`[cleanup] Purged ${emails.length} expired inboxes`);
}
