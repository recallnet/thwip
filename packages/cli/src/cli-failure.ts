import { executeCli, type CommandInvocation } from "./cli-args.js";
import { exitCodeFor, nextActionFor, type ExitCode } from "./queue-exit.js";

/**
 * The last thing between a thrown value and the terminal.
 *
 * Every command already ends in an exit class and a sentence. Anything that
 * threw instead of returning skipped all of it: node printed the error's stack,
 * the child-process object it came wrapped in, and exit 1. That is what `thwip
 * verify` did outside a repository and what `thwip ship` did on a branch already
 * pushed, and exit 1 tells an agent nothing about whether to retry.
 *
 * The rule here is that a failure with no better name still gets a code, a
 * class, and one sentence, and that whatever printed the useful part of the
 * message survives while the object carrying it does not.
 */

export interface ClassifiedFailure {
  readonly reasonCode: string;
  readonly exitCode: ExitCode;
  /** Ready to write: what failed, then what to do about it. */
  readonly text: string;
}

/**
 * The one line worth reading out of a thrown value.
 *
 * A failed child process carries what it printed on `stderr`, which is the part
 * a person can act on; the `message` around it repeats the command line and the
 * `cmd`, `stdout` and `signal` fields say nothing to anybody. Stack frames go
 * too: they name node's internals, never the developer's problem.
 */
export function failureDetail(error: unknown): string {
  const carried = (error as { stderr?: unknown } | null)?.stderr;
  const source =
    typeof carried === "string" && carried.trim().length > 0
      ? carried
      : error instanceof Error
        ? error.message
        : String(error);
  const line = source
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("at ") && !l.startsWith("hint:"));
  return (line ?? "thwip stopped without saying why").slice(0, 400);
}

export function classifyFailure(error: unknown): ClassifiedFailure {
  const reasonCode = "LOCAL_FAILURE";
  return {
    reasonCode,
    exitCode: exitCodeFor(reasonCode),
    text: `thwip: ${failureDetail(error)}\n${nextActionFor(reasonCode)}`,
  };
}

export interface CliProcessPorts {
  readonly dispatch: (invocation: CommandInvocation) => Promise<number>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Run a command and return an exit code, whatever happens inside it. */
export async function runCliProcess(argv: readonly string[], ports: CliProcessPorts): Promise<number> {
  try {
    return await executeCli(argv, ports);
  } catch (error) {
    const failure = classifyFailure(error);
    ports.stderr(failure.text + "\n");
    return failure.exitCode;
  }
}
