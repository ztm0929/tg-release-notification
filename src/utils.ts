export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeRepoArg(input: string): string | null {
  const s = (input || "").trim();
  if (!s) return null;

  // owner/repo
  const direct = s.replace(/^\s+|\s+$/g, "");
  const m1 = direct.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (m1) return `${m1[1]}/${m1[2]}`;

  // https://github.com/owner/repo(.git)?
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    if (u.hostname.toLowerCase() !== "github.com") return null;
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    if (!owner || !repo) return null;
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}

export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
