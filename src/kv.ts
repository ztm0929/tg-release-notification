import type { Env } from "./types";

const SUBS_KEY = "subs:v1";

export async function getSubs(env: Env): Promise<string[]> {
  const v = (await env.KV.get(SUBS_KEY, { type: "json" })) as unknown;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return [];
}

export async function addSubscription(
  env: Env,
  fullName: string,
): Promise<{ added: boolean; message: string }> {
  const subs = await getSubs(env);
  const normalized = fullName.toLowerCase();
  if (subs.some((s) => s.toLowerCase() === normalized)) {
    return { added: false, message: "订阅已存在。" };
  }

  subs.push(fullName);
  subs.sort((a, b) => a.localeCompare(b));
  await env.KV.put(SUBS_KEY, JSON.stringify(subs));
  return { added: true, message: "已添加订阅，正在尝试补发最近1条正式版…" };
}

export async function removeSubscription(env: Env, fullName: string): Promise<boolean> {
  const subs = await getSubs(env);
  const normalized = fullName.toLowerCase();
  const next = subs.filter((s) => s.toLowerCase() !== normalized);
  if (next.length === subs.length) return false;
  await env.KV.put(SUBS_KEY, JSON.stringify(next));
  return true;
}

export function stateKey(fullName: string): string {
  return `state:v1:${fullName.toLowerCase()}`;
}

export function etagKey(fullName: string): string {
  return `etag:v1:${fullName.toLowerCase()}`;
}

export async function getLastNotifiedId(env: Env, fullName: string): Promise<string | null> {
  return await env.KV.get(stateKey(fullName));
}

export async function setLastNotifiedId(env: Env, fullName: string, id: number): Promise<void> {
  await env.KV.put(stateKey(fullName), String(id));
}

export async function getEtag(env: Env, fullName: string): Promise<string | null> {
  return await env.KV.get(etagKey(fullName));
}

export async function setEtag(env: Env, fullName: string, etag: string): Promise<void> {
  await env.KV.put(etagKey(fullName), etag);
}

export async function clearStateFor(env: Env, fullName: string): Promise<void> {
  await env.KV.delete(stateKey(fullName));
  await env.KV.delete(etagKey(fullName));
}
