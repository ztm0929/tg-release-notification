import type { Env, TelegramUpdate, TelegramMessage, GitHubRelease } from "./types";
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
        "<code>/add owner/repo</code>  添加订阅（会在私聊补发最近1条正式版）",
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
        const title = latest.name?.trim() ? latest.name.trim() : latest.tag_name;
        const published = latest.published_at ? new Date(latest.published_at).toISOString() : "";
        const preview = buildReleaseMessage(fullName, title, latest.html_url, published, latest.body);

        // 新增订阅时的补发：只发给管理员私聊（不发到频道），并尝试静音发送
        await sendMessage(env, msg.chat.id, preview, "HTML", { silent: true });

        // 仍然记录 lastNotifiedId，避免下一次 cron 立刻重复推送同一条
        await setLastNotifiedId(env, fullName, latest.id);
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

const TELEGRAM_TEXT_LIMIT = 4096;

function cleanReleaseBody(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      let s = l;
      // 轻量 Markdown 清洗：尽量让内容可读，不追求完整渲染
      s = s.replace(/^#{1,6}\s+/, "");
      s = s.replace(/^[-*+]\s+/, "");
      s = s.replace(/^\d+\.\s+/, "");
      s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
      s = s.replace(/`([^`]+)`/g, "$1");
      s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
      s = s.replace(/__([^_]+)__/g, "$1");
      return s.trim();
    })
    .filter(Boolean);

  return lines.join("\n");
}

function buildReleaseMessage(fullName: string, title: string, url: string, publishedIso: string, body: string | null): string {
  const header = `${escapeHtml(fullName)} 发布了新版本\n<a href=\"${escapeHtml(url)}\">${escapeHtml(title)}</a>`;

  const published = publishedIso
    ? new Date(publishedIso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";

  const footer = published ? `发布时间：${published}` : "";

  const cleaned = body?.trim() ? cleanReleaseBody(body) : "";
  if (!cleaned) return [header, footer].filter(Boolean).join("\n");

  const MAX_LINES = 15;
  let lines = cleaned.split("\n").filter(Boolean);
  const originalLineCount = lines.length;
  const wasLongByLines = originalLineCount > MAX_LINES;
  if (wasLongByLines) lines = lines.slice(0, MAX_LINES);

  let excerpt = lines.join("\n");
  const MAX_CHARS = 1200;
  const wasLongByChars = excerpt.length > MAX_CHARS;
  if (wasLongByChars) excerpt = excerpt.slice(0, MAX_CHARS).trimEnd();

  const truncated = wasLongByLines || wasLongByChars || cleaned.length > excerpt.length;
  if (truncated) excerpt = `${excerpt}\n…`;

  const quote = truncated
    ? `<blockquote expandable>${escapeHtml(excerpt)}</blockquote>`
    : `<blockquote>${escapeHtml(excerpt)}</blockquote>`;

  // 先生成一次，如超限再逐步收缩 excerpt
  let text = [header, quote, footer].filter(Boolean).join("\n");
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text;

  // 超过 Telegram 限制：继续截断引用区
  let shrink = excerpt;
  while (text.length > TELEGRAM_TEXT_LIMIT && shrink.length > 100) {
    shrink = shrink.slice(0, Math.max(100, shrink.length - 200)).trimEnd();
    const q = `<blockquote expandable>${escapeHtml(`${shrink}\n…`)}</blockquote>`;
    text = [header, q, footer].filter(Boolean).join("\n");
  }

  // 兜底：仍超限则去掉 body
  if (text.length > TELEGRAM_TEXT_LIMIT) return [header, footer].filter(Boolean).join("\n");
  return text;
}

export async function notifyRelease(env: Env, fullName: string, r: GitHubRelease): Promise<void> {
  const title = r.name?.trim() ? r.name.trim() : r.tag_name;
  const published = r.published_at ? new Date(r.published_at).toISOString() : "";

  const text = buildReleaseMessage(fullName, title, r.html_url, published, r.body);
  await sendMessage(env, env.TELEGRAM_CHANNEL_ID, text, "HTML", { silent: true });
}

export async function sendMessage(
  env: Env,
  chatId: string | number,
  text: string,
  parseMode: "HTML" | "MarkdownV2" | undefined = undefined,
  opts: { silent?: boolean } = {},
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    disable_notification: Boolean(opts.silent),
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
