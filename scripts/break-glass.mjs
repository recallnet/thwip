/**
 * Deploying past a gate, on the record.
 *
 * The gate in `predeploy.mjs` refuses for five unrelated reasons, and one
 * variable used to excuse all of them together. `THWIP_DEPLOY_ANYWAY=1` was
 * reached for to ship from a branch and, in the same breath, waved through the
 * schema checks nobody was thinking about. A switch that turns off more than the
 * thing you are looking at is a switch that will one day turn off the thing you
 * needed.
 *
 * So an exception names the guard it excuses and says why, and every other guard
 * still refuses. The reason is not paperwork: it is the only thing that tells
 * the next reader whether the exception is still warranted.
 *
 * The deploy that used it stamps the worker, so production says what it is
 * running and why for as long as it is running it. On 9 August the queue could
 * not merge its own repair, the repair went out from a branch, and nothing
 * outside one terminal knew. The watchdog reads the stamp now, so an exception
 * that nobody comes back to clear is a failing check rather than a forgotten
 * one.
 */

/**
 * Every refusal that can be excused, named the way the refusal names it.
 *
 * A closed set, because a typo that quietly excused nothing would look exactly
 * like the gate having stopped working.
 */
export const GUARDS = Object.freeze([
  /** The checkout is missing commits that are on origin/main. */
  "behind-main",
  /** The tree is not main, so it has not been reviewed or merged. */
  "unmerged-tree",
  /** The live worker predates `/v1/schema`, so the schema cannot be asked. */
  "schema-endpoint-missing",
  /** `/v1/schema` could not be read, so the schema is unknown either way. */
  "schema-unreadable",
  /** Migrations this code needs have not been applied. */
  "pending-migrations",
]);

/** Enough words that the next reader learns something the guard name did not. */
const REASON_FLOOR = 20;

/**
 * Read `THWIP_BREAK_GLASS`, which is `guard[,guard]: why`.
 *
 * Returns the guards and the reason, or an error to print. An absent variable is
 * an ordinary deploy and excuses nothing.
 */
export function parseBreakGlass(value) {
  const raw = (value ?? "").trim();
  if (raw.length === 0) return { guards: [], reason: null, error: null };

  const split = raw.indexOf(":");
  const named = (split === -1 ? raw : raw.slice(0, split))
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const reason = split === -1 ? "" : raw.slice(split + 1).trim();

  const unknown = named.filter((name) => !GUARDS.includes(name));
  if (unknown.length > 0) {
    return {
      guards: [],
      reason: null,
      error:
        `THWIP_BREAK_GLASS names no such guard: ${unknown.join(", ")}.\n` +
        `The guards that can be excused are: ${GUARDS.join(", ")}.`,
    };
  }
  if (reason.length < REASON_FLOOR) {
    return {
      guards: [],
      reason: null,
      error:
        `THWIP_BREAK_GLASS needs a reason after the colon, in a sentence somebody reading\n` +
        `the running worker next month can act on. Got ${reason.length === 0 ? "none" : `"${reason}"`}.`,
    };
  }
  return { guards: named, reason, error: null };
}

/** Whether this declaration excuses that guard, and only that guard. */
export function excuses(declared, guard) {
  return declared.error === null && declared.guards.includes(guard);
}

/** What a guard prints when it refuses, including how to declare past it. */
export function breakGlassRefusal(guard, why) {
  return (
    `Refusing: ${why}\n\n` +
    `If this is deliberate, say so on the record and it will be deployed and published:\n` +
    `  THWIP_BREAK_GLASS="${guard}: why this cannot wait" pnpm deploy:staging`
  );
}

/**
 * What the worker is given, so production can say what it is running.
 *
 * Set on every deploy, including ordinary ones, where it is empty. An exception
 * that had to be remembered to be cleared would outlive its reason, and the next
 * person to read it would have no way to tell.
 */
export function exceptionStamp(declared, { branch, head, at }) {
  if (declared.error !== null || declared.guards.length === 0) return "";
  return JSON.stringify({ guards: declared.guards, reason: declared.reason, tree: `${branch}@${head}`, at });
}

/** Read a stamp back. Anything unreadable is no exception rather than a bad one. */
export function readException(stamp) {
  if (typeof stamp !== "string" || stamp.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(stamp);
    if (!Array.isArray(parsed.guards) || typeof parsed.reason !== "string") return null;
    return { guards: parsed.guards, reason: parsed.reason, tree: parsed.tree ?? null, at: parsed.at ?? null };
  } catch {
    return null;
  }
}
