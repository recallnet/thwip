import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { unwrittenFields } from "./unwritten-fields.mjs";

/**
 * A fixture repository. What this check reasons about is how one file's writes
 * line up with another file's reads, and a real tree cannot be made to hold a
 * specific shape.
 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "unwritten-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const found = (dir) => unwrittenFields({ root: dir }).map((f) => `${f.file}:${f.line} ${f.name}`);

const FACTS = `export interface Facts {
  readonly checks: "passing" | "pending" | "failing";
  readonly draft: boolean;
  readonly baseRef: string;
  readonly mergeable: boolean;
}
`;

describe("rule 2, a comparison nothing can satisfy", () => {
  it("reports a branch on a value production never writes", () => {
    // The live case. `NO_OBJECTION` sets the field to "passing" and nothing else
    // ever sets it, so the branch that blocks on a failing required check cannot
    // run and a failing check reads as passing at the merge gate.
    const dir = fixture({
      "facts.ts": FACTS,
      "derive.ts": `import type { Facts } from "./facts.js";
export const DEFAULTS: Facts = { checks: "passing", draft: false, baseRef: "", mergeable: true };
export function collect(f: Facts): string[] {
  const out: string[] = [];
  if (f.checks === "failing") out.push("FAILED");
  return out;
}
`,
    });
    expect(found(dir)).toEqual(["derive.ts:5 checks"]);
  });

  it("reports an unreachable case in a switch", () => {
    const dir = fixture({
      "facts.ts": FACTS,
      "derive.ts": `import type { Facts } from "./facts.js";
export const DEFAULTS: Facts = { checks: "passing", draft: false, baseRef: "", mergeable: true };
export function label(f: Facts): string {
  switch (f.checks) {
    case "passing":
      return "ok";
    case "failing":
      return "no";
  }
  return "";
}
`,
    });
    expect(found(dir)).toEqual(["derive.ts:7 checks"]);
  });

  it("reports an inequality against the only value ever written", () => {
    // `proofPolicyDigest` is null everywhere it is set, so the guard that fires
    // POLICY_CHANGED when it differs from the active digest is dead.
    const dir = fixture({
      "facts.ts": `export interface Facts {
  readonly digest: string | null;
  readonly draft: boolean;
  readonly baseRef: string;
  readonly mergeable: boolean;
}
`,
      "derive.ts": `import type { Facts } from "./facts.js";
export const DEFAULTS: Facts = { digest: null, draft: false, baseRef: "", mergeable: true };
export function changed(f: Facts): boolean {
  return f.digest !== null;
}
`,
    });
    expect(found(dir)).toEqual(["derive.ts:4 digest"]);
  });

  it("says nothing when production writes the value the branch tests", () => {
    const dir = fixture({
      "facts.ts": FACTS,
      "derive.ts": `import type { Facts } from "./facts.js";
export const DEFAULTS: Facts = { checks: "passing", draft: false, baseRef: "", mergeable: true };
export function fromApi(state: string): Facts {
  return { ...DEFAULTS, checks: state === "bad" ? "failing" : "passing" };
}
export function collect(f: Facts): boolean {
  return f.checks === "failing";
}
`,
    });
    expect(found(dir)).toEqual([]);
  });

  it("says nothing when a write is a value it cannot read", () => {
    // An incomplete write set makes every comparison look impossible, which is
    // the shape of a check that cries wolf. One unreadable write disqualifies
    // the property rather than shrinking the set.
    const dir = fixture({
      "facts.ts": FACTS,
      "derive.ts": `import type { Facts } from "./facts.js";
declare const computed: Facts["checks"];
export const DEFAULTS: Facts = { checks: computed, draft: false, baseRef: "", mergeable: true };
export function collect(f: Facts): boolean {
  return f.checks === "failing";
}
`,
    });
    expect(found(dir)).toEqual([]);
  });

  it("does not count a test as a writer", () => {
    // Every one of the four earlier cases had a suite that set the field by hand
    // and asserted on the branch. That is what made them survive review.
    const dir = fixture({
      "facts.ts": FACTS,
      "derive.ts": `import type { Facts } from "./facts.js";
export const DEFAULTS: Facts = { checks: "passing", draft: false, baseRef: "", mergeable: true };
export function collect(f: Facts): boolean {
  return f.checks === "failing";
}
`,
      "derive.test.ts": `import { DEFAULTS, collect } from "./derive.js";
collect({ ...DEFAULTS, checks: "failing" });
`,
    });
    expect(found(dir)).toEqual(["derive.ts:4 checks"]);
  });

  it("does not report a comparison inside a test", () => {
    const dir = fixture({
      "facts.ts": FACTS,
      "derive.ts": `import type { Facts } from "./facts.js";
export const DEFAULTS: Facts = { checks: "passing", draft: false, baseRef: "", mergeable: true };
export function read(f: Facts): string { return f.checks; }
`,
      "derive.test.ts": `import { DEFAULTS } from "./derive.js";
if (DEFAULTS.checks === "failing") throw new Error("x");
`,
    });
    expect(found(dir)).toEqual([]);
  });

  it("drops a property name two shapes declare", () => {
    // Nothing here resolves a read to a declaration except the name, so a name
    // used twice is a name this check cannot reason about. `activePolicyDigest`
    // is declared three times in this repository and is invisible for exactly
    // this reason.
    const dir = fixture({
      "facts.ts": FACTS,
      "other.ts": `export interface Other {
  readonly checks: string;
}
`,
      "derive.ts": `import type { Facts } from "./facts.js";
export const DEFAULTS: Facts = { checks: "passing", draft: false, baseRef: "", mergeable: true };
export function collect(f: Facts): boolean {
  return f.checks === "failing";
}
`,
    });
    expect(found(dir)).toEqual([]);
  });
});

describe("rule 1, a field nothing writes", () => {
  it("reports a required field left out of the shape that builds it", () => {
    const dir = fixture({
      "facts.ts": `export interface Facts {
  readonly checks: string;
  readonly draft: boolean;
  readonly baseRef: string;
  readonly mergeable: boolean;
}
`,
      "derive.ts": `import type { Facts } from "./facts.js";
export const DEFAULTS = { draft: false, baseRef: "", mergeable: true };
export function collect(f: Facts): string {
  return f.checks;
}
`,
    });
    expect(found(dir)).toEqual(["facts.ts:2 checks"]);
  });

  it("leaves an optional field alone", () => {
    const dir = fixture({
      "facts.ts": `export interface Facts {
  readonly checks?: string;
  readonly draft: boolean;
  readonly baseRef: string;
  readonly mergeable: boolean;
}
`,
      "derive.ts": `import type { Facts } from "./facts.js";
export const DEFAULTS = { draft: false, baseRef: "", mergeable: true };
export function collect(f: Facts): string | undefined {
  return f.checks;
}
`,
    });
    expect(found(dir)).toEqual([]);
  });

  it("leaves a shape nothing here builds alone", () => {
    // A GitHub response or a D1 row is described here and populated elsewhere.
    // Without an object literal that builds most of the shape there is no
    // evidence anyone was meant to write the field.
    const dir = fixture({
      "api.ts": `interface Blob {
  readonly content: string;
  readonly encoding: string;
  readonly size: number;
  readonly sha: string;
}
declare function get(): Promise<Blob>;
export async function read(): Promise<string> {
  const blob = await get();
  return blob.encoding === "base64" ? blob.content : "";
}
`,
    });
    expect(found(dir)).toEqual([]);
  });

  it("leaves a shape read out of a cast alone", () => {
    // `(await req.json()) as { … }` describes a request body. Nothing here
    // writes those fields and nothing should.
    const dir = fixture({
      "route.ts": `declare const request: { json(): Promise<unknown> };
export async function handle(): Promise<string> {
  const body = (await request.json()) as {
    canonicalJson: string;
    digest: string;
    version: number;
    kind: string;
  };
  return body.canonicalJson;
}
export const other = { digest: "a", version: 1, kind: "x" };
`,
    });
    expect(found(dir)).toEqual([]);
  });

  it("counts a write beside a spread", () => {
    const dir = fixture({
      "facts.ts": `export interface Facts {
  readonly checks: string;
  readonly draft: boolean;
  readonly baseRef: string;
  readonly mergeable: boolean;
}
`,
      "derive.ts": `import type { Facts } from "./facts.js";
export const DEFAULTS = { draft: false, baseRef: "", mergeable: true };
export function build(): Facts {
  return { ...DEFAULTS, checks: "passing" } as Facts;
}
export function collect(f: Facts): string {
  return f.checks;
}
`,
    });
    expect(found(dir)).toEqual([]);
  });

  it("counts an assignment as a write", () => {
    const dir = fixture({
      "facts.ts": `export interface Facts {
  checks: string;
  draft: boolean;
  baseRef: string;
  mergeable: boolean;
}
`,
      "derive.ts": `import type { Facts } from "./facts.js";
export const DEFAULTS = { draft: false, baseRef: "", mergeable: true };
export function set(f: Facts): string {
  f.checks = "passing";
  return f.checks;
}
`,
    });
    expect(found(dir)).toEqual([]);
  });
});
