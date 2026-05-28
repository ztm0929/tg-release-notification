import type { Env } from "./types";

function normalizeApiUrl(env: Env): { api: string; siteBase: string } {
  const raw = (env.MEDIAWIKI_API_BASE || "").trim();
  if (!raw) throw new Error("MEDIAWIKI_API_BASE 未配置，需填写完整的 api.php 地址，例如 https://ac-wiki.cn/api.php");
  // 强制要求用户提供完整的 api.php 地址（仓库约定）
  if (!raw.toLowerCase().endsWith("api.php")) {
    throw new Error("MEDIAWIKI_API_BASE 必须是 api.php 端点，例如 https://ac-wiki.cn/api.php");
  }
  const api = raw.replace(/\/+$/g, "");
  const siteBase = api.replace(/\/api.php$/i, "");
  return { api, siteBase };
}

export async function pageExists(env: Env, title: string): Promise<{ exists: boolean; url?: string }> {
  const { api, siteBase } = normalizeApiUrl(env);
  // Request the page content (revisions) so we can tell if the page is empty/placeholder
  const url = `${api}?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`MediaWiki query failed: ${res.status}`);
  const j = await res.json().catch(() => ({} as any)) as any;
  const pages = j.query?.pages || {};

  for (const k of Object.keys(pages)) {
    const p = pages[k];
    const pageUrl = `${siteBase.replace(/\/+$/, "")}/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;

    // If the page is missing, treat as not existing
    if (!p || p.missing) return { exists: false, url: pageUrl };

    // If there are revisions and the slot content is non-empty, treat as existing
    const rev = p.revisions?.[0];
    const content = rev?.slots?.main?.['*'];
    if (typeof content === 'string' && content.trim().length > 0) {
      return { exists: true, url: pageUrl };
    }

    // Page exists but has no content -> treat as not existing so bot will create it
    return { exists: false, url: pageUrl };
  }

  const pageUrl = `${siteBase.replace(/\/+$/, "")}/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
  return { exists: false, url: pageUrl };
}

async function generateFromDeepSeek(env: Env, title: string): Promise<string | null> {
  const endpoint = env.DEEPSEEK_API_URL?.trim();
  const key = env.DEEPSEEK_KEY?.trim();
  if (!endpoint || !key) return null;

  const systemPrompt = `你是 Ac-Wiki 的词条内容生成助手。\n\n任务：\n根据用户提供的名词、产品、技术、项目或概念，生成一段适合写入 Wiki 的简短介绍。\n\n要求：\n\n- 内容长度控制在 50～200 字\n- 使用简洁、客观、中立的中文\n- 优先说明：\n  - 它是什么\n  - 主要用途\n  - 核心特点\n- 避免营销化表达\n- 避免空泛描述\n- 不要使用：\n  - “是一款非常优秀的……”\n  - “致力于……”\n  - “强大的……”\n  - “革命性的……”\n- 不要编造不存在的信息\n- 若信息不明确，尽量保守描述\n\n输出规则：\n\n- 仅输出最终正文\n- 不要输出标题\n- 不要输出 Markdown\n- 不要输出解释过程\n- 不要输出引用来源\n- 不要输出额外说明`;

  const body = {
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: title },
    ],
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    stream: false,
  };

  const url = endpoint.replace(/\/+$/g, "") + "/v1/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    try {
      const text = await res.text();
      console.error(`DeepSeek request failed: ${res.status} ${text.slice(0, 200)}`);
    } catch (e) {
      console.error(`DeepSeek request failed: ${res.status} (and reading body failed)`);
    }
    return null;
  }
  const j = await res.json().catch(() => ({} as any)) as any;
  try {
    return j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || null;
  } catch (e) {
    console.error('DeepSeek response parsing error', e, j);
    return null;
  }
}

function extractCookies(setCookieHeader: string | null, existing = ""): string {
  if (!setCookieHeader) return existing;
  // Only keep name=value parts
  const parts = setCookieHeader.split(/, (?=[^;]+=)/g);
  const kvs = parts.map((p) => p.split(";")[0].trim()).filter(Boolean);
  const existingMap = new Map<string, string>();
  existing.split(/;\s*/).filter(Boolean).forEach((c) => {
    const [k, v] = c.split("=");
    if (k && v) existingMap.set(k, v);
  });
  for (const kv of kvs) {
    const [k, v] = kv.split("=");
    if (k && v) existingMap.set(k, v);
  }
  return Array.from(existingMap.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function createWikiPage(env: Env, title: string, content: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const { api, siteBase } = normalizeApiUrl(env);
  const username = env.MEDIAWIKI_BOT_USERNAME?.trim();
  const password = env.MEDIAWIKI_BOT_PASSWORD?.trim();
  if (!username || !password) return { ok: false, error: "MediaWiki 机器人凭据未配置" };

  let cookie = "";

  // 1) 获取 login token
  const t1 = await fetch(`${api}?action=query&meta=tokens&type=login&format=json`);
  cookie = extractCookies(t1.headers.get("set-cookie"), cookie);
  if (!t1.ok) {
    const body = await t1.text().catch(() => "");
    console.error(`login token request failed: ${t1.status} ${body.slice(0,200)}`);
    return { ok: false, error: `获取 login token 失败 ${t1.status}` };
  }
  const j1 = await t1.json().catch(() => ({} as any)) as any;
  const loginToken = j1.query?.tokens?.logintoken;
  if (!loginToken) return { ok: false, error: "无法获取 login token" };

  // 2) 登录
  const loginBody = new URLSearchParams();
  loginBody.append("action", "login");
  loginBody.append("format", "json");
  loginBody.append("lgname", username);
  loginBody.append("lgpassword", password);
  loginBody.append("lgtoken", loginToken);

  const loginRes = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: loginBody.toString(),
  });
  cookie = extractCookies(loginRes.headers.get("set-cookie"), cookie);
  if (!loginRes.ok) {
    const body = await loginRes.text().catch(() => "");
    console.error(`login failed: ${loginRes.status} ${body.slice(0,200)}`);
    return { ok: false, error: `登录失败 ${loginRes.status}` };
  }
  const jlogin = await loginRes.json().catch(() => ({} as any)) as any;
  const loginResult = jlogin?.login?.result;
  if (loginResult !== "Success" && loginResult !== "NeedToken") {
    // Some MW setups allow tokenless login; accept Success only
    return { ok: false, error: `登录未成功: ${loginResult}` };
  }

  // 3) 获取 csrf token
  const t2 = await fetch(`${api}?action=query&meta=tokens&format=json`, { headers: { Cookie: cookie } });
  cookie = extractCookies(t2.headers.get("set-cookie"), cookie);
  if (!t2.ok) {
    const body = await t2.text().catch(() => "");
    console.error(`csrf token request failed: ${t2.status} ${body.slice(0,200)}`);
    return { ok: false, error: `获取 csrf token 失败 ${t2.status}` };
  }
  const j2 = await t2.json().catch(() => ({} as any)) as any;
  const csrf = j2.query?.tokens?.csrftoken;
  if (!csrf) return { ok: false, error: "无法获取 csrf token" };

  // 4) 编辑页面
  const editBody = new URLSearchParams();
  editBody.append("action", "edit");
  editBody.append("format", "json");
  editBody.append("title", title);
  editBody.append("text", content);
  editBody.append("token", csrf);

  const editRes = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: editBody.toString(),
  });
  if (!editRes.ok) {
    const body = await editRes.text().catch(() => "");
    console.error(`edit request failed: ${editRes.status} ${body.slice(0,200)}`);
    return { ok: false, error: `编辑失败 ${editRes.status}` };
  }
  const jedit = await editRes.json().catch(() => ({} as any)) as any;
  if (jedit?.edit?.result === "Success") {
    const pageUrl = `${siteBase.replace(/\/+$/, "")}/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
    return { ok: true, url: pageUrl };
  }
  return { ok: false, error: JSON.stringify(jedit) };
}

export async function generateWikiArticle(env: Env, title: string): Promise<string | null> {
  return await generateFromDeepSeek(env, title);
}
