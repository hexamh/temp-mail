// ============================================================
// index.ts – TempMail Worker entry point
// ============================================================

import type { Env } from './types';
import { handleEmail }     from './email-handler';
import { handleFetch }     from './api';
import { handleScheduled } from './cleanup';

export default {
  // ── Incoming email via Email Routing ──────────────────────
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await handleEmail(message, env, ctx);
  },

  // ── HTTP API for Flutter ───────────────────────────────────
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return handleFetch(request, env);
  },

  // ── Scheduled cleanup (every 5 minutes via cron) ──────────
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await handleScheduled(env);
  },
};
