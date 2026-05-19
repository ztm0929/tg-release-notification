import type { Env, GitHubRelease } from "./types";
import { getEtag, setEtag } from "./kv";

export async function getLatestEligibleRelease(
  env: Env,
  fullName: string,
  opts: { useEtag: boolean; keywords?: string[] },
): Promise<GitHubRelease | null> {
  const keywords = opts.keywords ?? getBlocklist(env);
  const url = `${(env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/g, "")}/repos/${fullName}/releases?per_page=30`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "tg-release-notification",
  };

  if (opts.useEtag) {
    const etag = await getEtag(env, fullName);
    if (etag) headers["If-None-Match"] = etag;
  }

  const res = await fetch(url, { headers });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`GitHub API error ${res.status}`);

  const newEtag = res.headers.get("etag");
  if (newEtag) await setEtag(env, fullName, newEtag);

  const releases = (await res.json()) as GitHubRelease[];
  for (const r of releases) {
    if (!isEligible(r, keywords)) continue;
    return r;
  }

  return null;
}

export function getBlocklist(env: Env): string[] {
  const raw = env.KEYWORD_BLOCKLIST?.trim() || "alpha,beta,rc,pre-release";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isEligible(r: GitHubRelease, keywords: string[]): boolean {
  if (r.draft) return false;
  if (r.prerelease) return false;

  const title = `${r.name ?? ""} ${r.tag_name ?? ""}`.toLowerCase();
  for (const kw of keywords) {
    if (kw && title.includes(kw)) return false;
  }

  return true;
}
