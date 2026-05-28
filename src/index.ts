import type { Env, TelegramUpdate } from "./types";
import { handleTelegramUpdate } from "./telegram";
import { runCronOnce } from "./cron";
import { handleAdminSyncCommands } from "./admin";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (url.pathname === "/admin/sync-commands" && request.method === "POST") {
      return handleAdminSyncCommands(request, env);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      let update: TelegramUpdate;
      try {
        update = (await request.json()) as TelegramUpdate;
      } catch {
        return new Response("bad request", { status: 400 });
      }

      // Run handler and surface errors to logs for debugging
      ctx.waitUntil((async () => {
        try {
          await handleTelegramUpdate(update, env);
        } catch (e) {
          console.error('handleTelegramUpdate failed', e);
          throw e;
        }
      })());
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCronOnce(env));
  },
};
