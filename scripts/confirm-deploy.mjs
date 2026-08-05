/**
 * Whether the code just deployed is the code now serving.
 *
 * `wrangler deploy` returning 0 says the publish call succeeded, not that
 * traffic is answered by the bundle just uploaded. On staging that gap showed
 * up three times in one day: the pull request was merged, the checkout was
 * current, `predeploy.mjs` passed, `wrangler deploy` exited zero, and the page
 * being served was still the old one. Each time it was caught only by fetching
 * the live page and diffing it by hand.
 *
 * `/health` already reports the `BUILD_SHA` the Worker was deployed with
 * (`apps/control-plane/src/index.ts`), and `deploy:staging` already stamps one
 * with `build-sha.mjs`. This asks `/health` for it, on a schedule, until it
 * matches the sha that was just deployed or the wait runs out.
 *
 * A confirmation that passes on a timeout is worse than no confirmation: it
 * turns "we don't know" into "it worked". So a sha that never appears is a
 * failure, not a warning, and it says what is serving instead so the gap is
 * visible without a second fetch.
 */

/**
 * `build-sha.mjs` marks a dirty working tree with a `-dirty` suffix on the
 * commit it sits on, not a hash of the uncommitted change itself. Two dirty
 * deploys cut from the same commit, with different uncommitted edits, stamp
 * the identical sha. If `/health` was already serving `<head>-dirty` from an
 * earlier dirty deploy, this deploy's poll would read a match on its first
 * request, before the new bundle had even finished uploading — a pass that
 * confirms nothing, which is exactly the shape of failure this script exists
 * to catch. There is no fix that keeps the check meaningful here beyond saying
 * so: a dirty-tree confirmation is weaker evidence than a clean one, and the
 * caller needs to know that rather than read a plain "confirmed".
 */
export function dirtyShaCaveat(sha) {
  if (!sha.endsWith("-dirty")) return null;
  return (
    `${sha} names the commit, not the uncommitted change, so it is not unique across dirty deploys.\n` +
    `A match below only shows /health serves *some* dirty build at this commit, not that it is this one.\n` +
    `Commit before deploying if this needs to be verifiable.`
  );
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `url` until its `buildSha` is `expectedSha` or `timeoutMs` elapses.
 *
 * Every clock and I/O call is injectable so the timeout path can be tested
 * without a test that actually waits two minutes for one.
 */
export async function waitForBuildSha({
  url,
  expectedSha,
  fetchImpl = fetch,
  sleepMs = 3000,
  timeoutMs = 120000,
  sleep = defaultSleep,
  now = Date.now,
  onProgress = () => {},
}) {
  const start = now();
  let lastSha = null;
  let lastError = null;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (response.ok) {
        const body = await response.json();
        lastSha = typeof body.buildSha === "string" ? body.buildSha : null;
        lastError = null;
        if (lastSha === expectedSha) {
          return { ok: true, sha: lastSha, attempts, waitedMs: now() - start };
        }
      } else {
        lastError = `${response.status} ${response.statusText}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const elapsed = now() - start;
    onProgress({ attempts, elapsed, lastSha, lastError });
    if (elapsed >= timeoutMs) {
      return { ok: false, sha: lastSha, error: lastError, attempts, waitedMs: elapsed };
    }
    await sleep(sleepMs);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { liveHealthUrl } = await import("./deploy-identity.mjs");

  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };

  const targetEnv = flag("--env", "staging");
  const expectedSha = flag("--sha", null);
  if (!expectedSha) {
    console.error("Refusing: confirm-deploy.mjs needs --sha, the value deploy:staging just passed wrangler.");
    process.exit(1);
  }

  const url = liveHealthUrl(targetEnv);
  console.log(`confirming ${url} serves ${expectedSha}`);

  const caveat = dirtyShaCaveat(expectedSha);
  if (caveat !== null) console.warn(`\n${caveat}\n`);

  const result = await waitForBuildSha({
    url,
    expectedSha,
    onProgress: ({ attempts, elapsed, lastSha, lastError }) => {
      const seen = lastError ? `error: ${lastError}` : `serving ${lastSha ?? "(no buildSha field)"}`;
      console.log(`  [${Math.round(elapsed / 1000)}s] attempt ${attempts}: ${seen}, waiting for ${expectedSha}`);
    },
  });

  if (result.ok) {
    console.log(`\nconfirmed: ${url} serves ${result.sha} after ${Math.round(result.waitedMs / 1000)}s`);
    if (caveat !== null) console.warn(`(dirty-tree caveat still applies: ${expectedSha} is not unique)`);
    process.exit(0);
  }

  console.error(
    `\nRefusing to call this deployed: after ${Math.round(result.waitedMs / 1000)}s, ${url} ` +
      (result.error
        ? `could not be read (${result.error}).`
        : `still serves ${result.sha ?? "(no buildSha field)"}, not ${expectedSha}.`) +
      `\nThe publish exited zero, but traffic is not answered by the build just uploaded.`,
  );
  process.exit(1);
}
