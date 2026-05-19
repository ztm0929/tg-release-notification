import type { Env } from "./types";
import { getSubs, getLastNotifiedId, setLastNotifiedId } from "./kv";
import { getLatestEligibleRelease, getBlocklist } from "./github";
import { notifyRelease } from "./telegram";
import { mapWithConcurrency } from "./utils";

export async function runCronOnce(env: Env): Promise<void> {
  const subs = await getSubs(env);
  if (subs.length === 0) return;

  const keywords = getBlocklist(env);

  await mapWithConcurrency(subs, 5, async (fullName) => {
    try {
      const latest = await getLatestEligibleRelease(env, fullName, { useEtag: true, keywords });
      if (!latest) return;

      const lastId = await getLastNotifiedId(env, fullName);
      if (lastId && String(latest.id) === lastId) return;

      await notifyRelease(env, fullName, latest);
      await setLastNotifiedId(env, fullName, latest.id);
    } catch (e) {
      // Best-effort: continue other repos
      console.warn("cron error", fullName, e);
    }
  });
}
