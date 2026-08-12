import { describe, expect, it, vi } from "vitest";
import { executeCli, parseCliArgs, type CommandInvocation } from "./cli-args.js";
import { EXIT } from "./queue-exit.js";

const QUEUE_SUBCOMMANDS = [
  "status",
  "list",
  "join",
  "leave",
  "pause",
  "resume",
  "rebaseline",
  "eject",
  "bypass",
  "explain",
  "reconcile",
  "repair",
  "doctor",
  "work",
] as const;

const HELP_TARGETS: readonly (readonly string[])[] = [
  ["login"],
  ["ship"],
  ["queue"],
  ...QUEUE_SUBCOMMANDS.map((subcommand) => ["queue", subcommand]),
  ["init"],
  ["keys"],
  ["keys", "status"],
  ["setup"],
  ["run"],
  ["verify"],
  ["policy"],
  ["policy", "digest"],
  ["version"],
];

describe("version", () => {
  // A CLI that cannot say which build it is leaves everybody guessing which
  // worktree the binary on their PATH came from, which is how a bug in ship
  // survived a day of use.
  it.each([["version"], ["--version"], ["-v"]])("routes %s to the version command", (argv) => {
    expect(parseCliArgs([argv])).toEqual({ kind: "command", invocation: { command: "version", argv: [] } });
  });

  it("takes no options", () => {
    expect(parseCliArgs(["version", "--json"])).toMatchObject({ kind: "error" });
  });
});

describe("help", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])("prints global help for %j", async (argv) => {
    const stdout = vi.fn();
    const dispatch = vi.fn<(invocation: CommandInvocation) => Promise<number>>();
    await expect(executeCli(argv, { dispatch, stdout, stderr: vi.fn() })).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("USAGE"));
    expect(dispatch).not.toHaveBeenCalled();
  });

  for (const target of HELP_TARGETS) {
    for (const flag of ["--help", "-h"]) {
      it(`${target.join(" ")} ${flag} is resolved before every side-effect boundary`, async () => {
        const effects = {
          suiteExecutions: 0,
          networkMutations: 0,
          signingOperations: 0,
          worktreeMutations: 0,
          commitMessageMutations: 0,
          headChanges: 0,
        };
        const dispatch = vi.fn(async () => {
          for (const effect of Object.keys(effects) as Array<keyof typeof effects>) effects[effect] += 1;
          return 0;
        });
        const stdout = vi.fn();

        await expect(
          executeCli([...target, flag], { dispatch, stdout, stderr: vi.fn() }),
        ).resolves.toBe(0);

        expect(stdout).toHaveBeenCalledWith(expect.stringMatching(/Usage|USAGE/));
        expect(dispatch).not.toHaveBeenCalled();
        expect(effects).toEqual({
          suiteExecutions: 0,
          networkMutations: 0,
          signingOperations: 0,
          worktreeMutations: 0,
          commitMessageMutations: 0,
          headChanges: 0,
        });
      });
    }
  }

  it("supports command help through the help command", () => {
    expect(parseCliArgs(["help", "run"])).toMatchObject({ kind: "help" });
    expect(parseCliArgs(["help", "queue", "bypass"])).toMatchObject({ kind: "help" });
  });
});

describe("thwip doctor", () => {
  it("is a top-level command, because onboarding fails above the queue as often as inside it", () => {
    const action = parseCliArgs(["doctor"]);
    expect(action).toEqual({ kind: "command", invocation: { command: "doctor", argv: [] } });
  });

  it("refuses a flag it does not know rather than silently ignoring it", () => {
    expect(parseCliArgs(["doctor", "--strict"])).toEqual({ kind: "error", message: "unknown flag --strict" });
  });

  it("documents the opt-out and the exit contract in its own help", () => {
    const action = parseCliArgs(["doctor", "--help"]);
    expect(action.kind).toBe("help");
    const text = action.kind === "help" ? action.text : "";
    expect(text).toContain("--allow-unread");
    expect(text).toContain("zero only");
  });
});

describe("fail-closed arguments", () => {
  const invalid = [
    ["--unknown"],
    ["login", "--unknown"],
    ["ship", "--unknown"],
    ["queue", "status", "--repo", "recallnet/thwip", "--unknown"],
    ["queue", "status", "--repo", "recallnet/thwip", "-x"],
    ["queue", "work", "--repo", "recallnet/thwip"],
    ["init", "--unknown"],
    ["keys", "status", "--unknown"],
    ["setup", "--unknown"],
    ["run", "--unknown"],
    ["run", "unexpected"],
    ["verify", "--unknown"],
    ["policy", "digest", "--unknown"],
  ];

  it.each(invalid.map((argv) => [argv]))("rejects %j without dispatch", async (argv) => {
    const dispatch = vi.fn<(invocation: CommandInvocation) => Promise<number>>();
    const stderr = vi.fn();
    await expect(executeCli(argv, { dispatch, stdout: vi.fn(), stderr })).resolves.toBe(EXIT.usage);
    expect(stderr).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects missing flag values without dispatch", async () => {
    const dispatch = vi.fn<(invocation: CommandInvocation) => Promise<number>>();
    await expect(
      executeCli(["run", "--base"], { dispatch, stdout: vi.fn(), stderr: vi.fn() }),
    ).resolves.toBe(EXIT.usage);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("dispatch", () => {
  it.each([
    [["login"], "login"],
    [["ship"], "ship"],
    [["queue", "status", "--repo", "recallnet/thwip"], "queue"],
    [["queue", "work", "--repo", "recallnet/thwip", "--watch"], "queue"],
    [["init", "--required", "lint"], "init"],
    [["keys"], "keys-status"],
    [["keys", "status"], "keys-status"],
    [["setup"], "setup"],
    [["setup", "--install-push-warning"], "setup"],
    [["run"], "run"],
    [["verify", "--json"], "verify"],
    [["verify", "--commit", "a".repeat(40)], "verify"],
    [["policy", "digest"], "policy-digest"],
    [["doctor"], "doctor"],
    [["doctor", "--json", "--allow-unread"], "doctor"],
    [["doctor", "--repo", "recallnet/thwip", "--branch", "main"], "doctor"],
  ] as const)("routes %j to %s only after validation", async (argv, expected) => {
    const dispatch = vi.fn(async () => 0);
    await expect(
      executeCli(argv, { dispatch, stdout: vi.fn(), stderr: vi.fn() }),
    ).resolves.toBe(0);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ command: expected }));
  });
});
