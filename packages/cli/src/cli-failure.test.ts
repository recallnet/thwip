import { describe, expect, it } from "vitest";
import { classifyFailure, runCliProcess } from "./cli-failure.js";
import { EXIT } from "./queue-exit.js";
import { NEXT_ACTION } from "@thwip/vocabulary";

/**
 * The shape node hands you when a child process exits non-zero. Reproduced
 * literally, because printing this object is the bug: `thwip verify` outside a
 * repository, and `thwip ship` on a branch already pushed, both ended with a
 * stack trace, `cmd:`, `stdout:` and `stderr:` on the terminal and exit 1.
 */
function execFileFailure(): Error {
  const error = new Error("Command failed: git log -1 --format=%B\nfatal: not a git repository\n");
  return Object.assign(error, {
    code: 128,
    killed: false,
    signal: null,
    cmd: "git log -1 --format=%B",
    stdout: "",
    stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
  });
}

describe("classifying something that threw", () => {
  it("gives it an exit class instead of leaving it as one", () => {
    expect(classifyFailure(execFileFailure())).toMatchObject({
      reasonCode: "LOCAL_FAILURE",
      exitCode: EXIT.invariant,
    });
  });

  it("says the one line the command printed and nothing about the object it came in", () => {
    const { text } = classifyFailure(execFileFailure());
    expect(text).toContain("fatal: not a git repository");
    expect(text).not.toContain("cmd:");
    expect(text).not.toContain("stdout:");
    expect(text).not.toContain("    at ");
    expect(text).not.toContain("node:internal");
  });

  it("ends with the sentence the rest of thwip would have printed", () => {
    expect(classifyFailure(execFileFailure()).text).toContain(NEXT_ACTION.LOCAL_FAILURE);
  });

  it("copes with a thrown value that is not an error at all", () => {
    const { exitCode, text } = classifyFailure("something went wrong");
    expect(exitCode).toBe(EXIT.invariant);
    expect(text).toContain("something went wrong");
  });
});

describe("the process boundary", () => {
  const io = () => {
    const err: string[] = [];
    return { err, stdout: () => {}, stderr: (t: string) => err.push(t) };
  };

  it("returns what the command returned when nothing throws", async () => {
    const out = io();
    const code = await runCliProcess(["verify"], {
      dispatch: async () => 0,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);
  });

  it("exits with a classified code and a sentence when a command throws", async () => {
    const out = io();
    const code = await runCliProcess(["verify"], {
      dispatch: async () => {
        throw execFileFailure();
      },
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(EXIT.invariant);
    expect(code).not.toBe(1);
    const said = out.err.join("");
    expect(said).toContain("fatal: not a git repository");
    expect(said).toContain(NEXT_ACTION.LOCAL_FAILURE);
    expect(said).not.toContain("    at ");
  });
});
