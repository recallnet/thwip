import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nobody writes a merge commit's details by hand.
 *
 * `merge-commit.ts` owns the operation id, the title and the attribution
 * trailer, because each of them is agreed with somewhere else: the trailer with
 * `external-push.ts`, which uses it to tell the queue's own merges from a push
 * around the queue, and the title and message with the YAML in
 * `.github/workflows/thwip-merge.yml`.
 *
 * Retyping one is how a second merge path came to write merges carrying no
 * attribution, which would have been read back as external pushes and appended
 * a chain link for work the queue itself did. That path is deleted; four more
 * copies of the operation id sat in `routes.ts` agreeing with the helper only
 * by luck.
 *
 * The same shape has produced three bug families in this directory now: twelve
 * copies of the queue-key guard all with the same wrong message, three copies
 * of every reason code's sentence, and this. So it is checked rather than
 * remembered.
 */

const dir = fileURLToPath(new URL(".", import.meta.url));

/** Written by hand, and each owned by a function in merge-commit.ts. */
const SPELLED_BY_HAND = [
  { pattern: /`merge_\$\{/, owner: "mergeOperationId()" },
  { pattern: /`Merge pull request #\$\{/, owner: "mergeCommitTitle()" },
  { pattern: /["'`]thwip-queue-operation:/, owner: "queueAttributionTrailer()" },
];

function sources(): Array<{ name: string; text: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "merge-commit.ts")
    .map((name) => ({ name, text: readFileSync(`${dir}${name}`, "utf8") }));
}

describe("merge commit details", () => {
  it("come from merge-commit.ts and are not retyped", () => {
    for (const { name, text } of sources()) {
      for (const { pattern, owner } of SPELLED_BY_HAND) {
        expect(pattern.test(text), `${name} spells out what ${owner} owns`).toBe(false);
      }
    }
  });

  /** The guard is worthless if it is scanning nothing. */
  it("scans the files that write merges", () => {
    const names = sources().map((s) => s.name);
    expect(names).toContain("routes.ts");
    // The one place the control plane asks GitHub for a merge, and the one that
    // signs the intent naming the operation it will perform.
    expect(names).toContain("github-port.ts");
    expect(names).toContain("attestation.ts");
  });
});
