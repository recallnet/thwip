import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The executable boundary, held to the stdout contract every command relies on.
 *
 * `process.stdout.write` may be asynchronous when stdout is a pipe. Calling
 * `process.exit` immediately afterwards cut a valid 146 KB doctor report at
 * Node's 65,536-byte pipe buffer, leaving `--json` consumers with invalid JSON.
 * The executable is intentionally read as source because importing it would run
 * the CLI; this keeps a later direct exit from silently restoring truncation.
 */
const MAIN = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
const MAIN_START = MAIN.indexOf("async function main()");
const MAIN_END = MAIN.indexOf("\n}\n", MAIN_START) + 2;
const MAIN_FUNCTION = MAIN.slice(MAIN_START, MAIN_END);

describe("the executable process boundary", () => {
  it("lets buffered output drain before the process exits", () => {
    expect(MAIN_START).toBeGreaterThan(-1);
    expect(MAIN_END).toBeGreaterThan(MAIN_START);
    expect(MAIN_FUNCTION).toContain("process.exitCode = code");
    expect(MAIN_FUNCTION).not.toContain("process.exit(");
  });
});
