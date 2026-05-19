import type { Env } from "./types";

export async function syncCommands(env: Env): Promise<void> {
  const commands = [
    { command: "add", description: "添加订阅" },
    { command: "remove", description: "移除订阅" },
    { command: "list", description: "查看订阅列表" },
  ];

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`setMyCommands failed: ${res.status} ${body}`);
  }
}

export async function handleAdminSyncCommands(request: Request, env: Env): Promise<Response> {
  // 简单的认证：检查 Authorization header 是否匹配 TELEGRAM_BOT_TOKEN
  const auth = request.headers.get("Authorization");
  const expectedAuth = `Bearer ${env.TELEGRAM_BOT_TOKEN}`;

  if (auth !== expectedAuth) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    await syncCommands(env);
    return new Response(
      JSON.stringify({
        ok: true,
        message: "Commands synchronized successfully",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({
        ok: false,
        error,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
