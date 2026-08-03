import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { entryPoints, uncalledExports } from "./uncalled-exports.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A fixture repository, because the interesting cases are about how modules
 * refer to each other and a real one cannot be made to hold a specific shape.
 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "uncalled-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const found = (dir, entries = new Set()) =>
  uncalledExports({ root: dir, entries }).map((d) => `${d.file}#${d.name}`);

describe("uncalled exports", () => {
  it("reports an exported function nothing imports", () => {
    const dir = fixture({
      "a.ts": "export function used() {}\nexport function orphan() {}\n",
      "b.ts": 'import { used } from "./a.js";\nconst x = used;\nconsole.log(x);\n',
    });
    expect(found(dir)).toEqual(["a.ts#orphan"]);
  });

  it("counts a name the module uses itself", () => {
    // A helper called only by its own module is not dead code. Reporting it
    // would bury the real cases under notes about a keyword.
    const dir = fixture({
      "a.ts": "export function helper() {}\nexport function exported() { helper(); }\n",
      "b.ts": 'import { exported } from "./a.js";\nconst x = exported;\nconsole.log(x);\n',
    });
    expect(found(dir)).toEqual([]);
  });

  it("counts a lazily imported module as reached", () => {
    // The CLI lazy-loads its Dagger runner so that repositories using the command
    // runner never pay for the download-and-spawn module. Reading only top-level
    // import declarations reported all three of its live functions as dead, and
    // they sat in the allowlist under the reason "dagger runner, unwired". The
    // check had invented the condition it exists to find.
    const dir = fixture({
      "a.ts": "export function lazy() {}\n",
      "b.ts": 'export async function go() { const { lazy } = await import("./a.js"); lazy(); }\n',
      "c.ts": 'import { go } from "./b.js";\ngo();\n',
    });
    expect(found(dir)).toEqual([]);
  });

  it("does not let a field of the same name hide a function", () => {
    // `liveGuardDigest` is a function in evidence.ts and a field name in an
    // interface above it. Counting the field as a mention made the function look
    // self-used, so the only implementation of the final live guard sat called by
    // nothing but its own test while this check reported nothing.
    const dir = fixture({
      "a.ts": "export interface Facts { orphan: string }\nexport function orphan() {}\n",
    });
    expect(found(dir)).toEqual(["a.ts#orphan"]);
  });

  it("still counts a shorthand property as a use", () => {
    // `{ orphan }` reads the binding, unlike `{ orphan: x }` which only names a key.
    const dir = fixture({
      "a.ts": "function orphan() {}\nexport const bag = { orphan };\n",
      "b.ts": 'import { bag } from "./a.js";\nconsole.log(bag);\n',
    });
    expect(found(dir)).toEqual([]);
  });

  it("does not count reading a property as using a function of that name", () => {
    const dir = fixture({
      "a.ts": "export function orphan() {}\nexport const read = (x: { orphan: string }) => x.orphan;\n",
      "b.ts": 'import { read } from "./a.js";\nconsole.log(read);\n',
    });
    expect(found(dir)).toEqual(["a.ts#orphan"]);
  });

  it("does not count a test as a caller", () => {
    // Every one of the four cases this exists for had a thorough suite. A test
    // proves a function works, never that anything runs it.
    const dir = fixture({
      "a.ts": "export function orphan() {}\n",
      "a.test.ts": 'import { orphan } from "./a.js";\norphan();\n',
    });
    expect(found(dir)).toEqual(["a.ts#orphan"]);
  });

  it("does not report the test's own exports", () => {
    const dir = fixture({ "a.test.ts": "export function helper() {}\n" });
    expect(found(dir)).toEqual([]);
  });

  it("does not report fixtures kept under test/", () => {
    const dir = fixture({ "test/d1.ts": "export function migrations() {}\n" });
    expect(found(dir)).toEqual([]);
  });

  it("follows a barrel rather than counting it as a caller", () => {
    // The failure mode of every off-the-shelf tool: a package index re-exports
    // everything, so everything looks used and whole packages go unchecked.
    const dir = fixture({
      "pkg/index.ts": 'export * from "./a.js";\n',
      "pkg/a.ts": "export function used() {}\nexport function orphan() {}\n",
      "app.ts": 'import { used } from "./pkg/index.js";\nconst x = used;\nconsole.log(x);\n',
    });
    expect(found(dir)).toEqual(["pkg/a.ts#orphan"]);
  });

  it("follows a named re-export to where the name is declared", () => {
    const dir = fixture({
      "pkg/index.ts": 'export { used, orphan } from "./a.js";\n',
      "pkg/a.ts": "export function used() {}\nexport function orphan() {}\n",
      "app.ts": 'import { used } from "./pkg/index.js";\nconst x = used;\nconsole.log(x);\n',
    });
    expect(found(dir)).toEqual(["pkg/a.ts#orphan"]);
  });

  it("leaves types alone", () => {
    // A type is used structurally, without ever being named in an import, so a
    // check that reads names cannot tell the difference between a spare one and
    // one that every value in the file is shaped by.
    const dir = fixture({
      "a.ts": "export interface Shape { x: number }\nexport type Other = string;\n",
    });
    expect(found(dir)).toEqual([]);
  });

  it("leaves entry points alone", () => {
    const dir = fixture({ "main.ts": "export default {};\nexport class Thing {}\n" });
    expect(found(dir, new Set(["main.ts"]))).toEqual([]);
  });

  it("treats a namespace import as using everything", () => {
    const dir = fixture({
      "a.ts": "export function one() {}\nexport function two() {}\n",
      "b.ts": 'import * as a from "./a.js";\nconst x = a;\nconsole.log(x);\n',
    });
    expect(found(dir)).toEqual([]);
  });
});

describe("entry points", () => {
  /**
   * Read from what declares them, never listed here. A hard-coded list reports
   * the next Durable Object or bundle entry as dead on the day it is added, and
   * whoever hits that reaches for the allowance list instead.
   */
  it("come from the configuration that names them", () => {
    const entries = entryPoints(root);
    expect(entries).toContain("apps/control-plane/src/index.ts");
    expect(entries).toContain("packages/cli/src/main.ts");
    expect(entries).toContain("packages/action/src/main.ts");
    expect(entries).toContain("apps/control-plane/web/src/main.tsx");
  });

  /**
   * `@better-auth/cli generate` reads `src/auth.cli.ts` by path to emit the
   * auth schema. It never imports through the app's module graph, so the file
   * had no call site and the devDependency had no user, and two different
   * tools called each of them dead. The `auth:schema` package script names the
   * relationship, and this reads it from there rather than excusing the file.
   */
  it("counts a source file a package script hands to a tool by path", () => {
    expect(entryPoints(root)).toContain("apps/control-plane/src/auth.cli.ts");
  });
});
