import type { Env, TelegramUpdate, TelegramMessage } from "./types";
import { getSubs, addSubscription, removeSubscription, clearStateFor, getLastNotifiedId, setLastNotifiedId } from "./kv";
import { getLatestEligibleRelease } from "./github";
import { escapeHtml, normalizeRepoArg } from "./utils";

export async function handleTelegramUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;
  if (msg.chat.type !== "private") return;

  const fromId = msg.from?.id;
  if (!fromId) return;

  const adminId = (env.ADMIN_USER_ID || "").trim();
  if (!adminId) {
    await sendMessage(
      env,
      msg.chat.id,
      "ADMIN_USER_ID 未配置：请在 wrangler.toml/Cloudflare 环境变量中设置。\n使用 getUpdates API 或第三方 bot 获取 user id。",
      "HTML",
    );
    return;
  }

  const text = msg.text.trim();
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0];
  const arg = rest.join(" ").trim();

  if (cmd === "/whoami") {
    await sendMessage(env, msg.chat.id, `Telegram user id: <code>${fromId}</code>`, "HTML");
    return;
  }

  if (String(fromId) !== adminId) {
    await sendMessage(env, msg.chat.id, "无权限：只有管理员可以管理订阅。", "HTML");
    return;
  }

  if (cmd === "/start" || cmd === "/help") {
    await sendMessage(
      env,
      msg.chat.id,
      [
        "可用命令：",
        "<code>/add owner/repo</code>  添加订阅（并补发最近1条正式版）",
        "<code>/remove owner/repo</code>  移除订阅",
        "<code>/list</code>  查看订阅列表",
      ].join("\n"),
      "HTML",
    );
    return;
  }

  if (cmd === "/list") {
    const subs = await getSubs(env);
    const lines = subs.length
      ? subs.map((r) => `- <code>${escapeHtml(r)}</code>`)
      : ["(空)"];
    await sendMessage(env, msg.chat.id, `当前订阅（${subs.length}）：\n${lines.join("\n")}`, "HTML");
    return;
  }

  if (cmd === "/add") {
    const fullName = normalizeRepoArg(arg);
    if (!fullName) {
      await sendMessage(env, msg.chat.id, "用法：<code>/add owner/repo</code>", "HTML");
      return;
    }

    const { added, message } = await addSubscription(env, fullName);
    await sendMessage(env, msg.chat.id, message, "HTML");

    if (added) {
      const latest = await getLatestEligibleRelease(env, fullName, { useEtag: false });
      if (latest) {
        await notifyRelease(env, fullName, latest);
        await setLastNotifiedId(env, fullName, latest.id);
        await sendMessage(
          env,
          msg.chat.id,
          `已补发：<a href=\"${escapeHtml(latest.html_url)}\">${escapeHtml(latest.tag_name)}</a>`,
          "HTML",
        );
      } else {
        await sendMessage(
          env,
          msg.chat.id,
          "未找到可用的正式版 release（已添加订阅，后续有新版本会推送）。",
          "HTML",
        );
      }
    }

    return;
  }

  if (cmd === "/remove") {
    const fullName = normalizeRepoArg(arg);
    if (!fullName) {
      await sendMessage(env, msg.chat.id, "用法：<code>/remove owner/repo</code>", "HTML");
      return;
    }

    const removed = await removeSubscription(env, fullName);
    if (removed) {
      await clearStateFor(env, fullName);
    }
    await sendMessage(env, msg.chat.id, removed ? "已移除订阅。" : "订阅不存在。", "HTML");
    return;
  }

  await sendMessage(env, msg.chat.id, "未知命令，发送 /help 查看用法。", "HTML");
}

export async function notifyRelease(env: Env, fullName: string, r: { tag_name: string; name: string | null; html_url: string; published_at: string | null }): Promise<void> {
  const title = r.name?.trim() ? r.name.trim() : r.tag_name;
  const published = r.published_at ? new Date(r.published_at).toISOString() : "";

  const text = [
    `<b>${escapeHtml(fullName)}</b>`,
    `<b>${escapeHtml(title)}</b>`,
    `<a href=\"${escapeHtml(r.html_url)}\">${escapeHtml(r.html_url)}</a>`,
    published ? `<code>${escapeHtml(published)}</code>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await sendMessage(env, env.TELEGRAM_CHANNEL_ID, text, "HTML");
}

export async function sendMessage(
  env: Env,
  chatId: string | number,
  text: string,
  parseMode: "HTML" | "MarkdownV2" | undefined = undefined,
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) payload.parse_mode = parseMode;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}
