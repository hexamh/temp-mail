import type { Env } from './types';
import { handleEmail }     from './email-handler';
import { handleFetch }     from './api';
import { handleScheduled } from './cleanup';

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await handleEmail(message, env, ctx);
  },

  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await handleScheduled(env);
  },
};
