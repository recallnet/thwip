import { planQueueCommand } from "./queue-commands.js";
import { EXIT } from "./queue-exit.js";

export type CliCommand =
  | "login"
  | "ship"
  | "queue"
  | "init"
  | "verify"
  | "verify-chain"
  | "keys-status"
  | "setup"
  | "run"
  | "policy-digest";

export interface CommandInvocation {
  readonly command: CliCommand;
  readonly argv: readonly string[];
}

export type CliAction =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "command"; readonly invocation: CommandInvocation }
  | { readonly kind: "error"; readonly message: string };

interface CliPorts {
  readonly dispatch: (invocation: CommandInvocation) => Promise<number>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface OptionSpec {
  readonly boolean?: readonly string[];
  readonly value?: readonly string[];
}

const HELP_FLAGS = new Set(["--help", "-h"]);

const HELP = `thwip — verified local CI (https://thwip.recall.net)

Run CI where the code lives, sign a proof of the exact Git tree, and let a
protected GitHub check verify it. Repositories inherit organization defaults;
an optional thwip.yaml overrides them after it reaches the default branch.

USAGE
  thwip <command> [options]

COMMANDS
  login                     Sign in via device code.
  ship                      Run suites, sign, push, and manage the queue.
  queue <subcommand>        Inspect or operate the branch queue.
  init                      Write thwip.yaml for this repository.
  keys status               Show the signing key and GitHub registration.
  setup                     Print the machine setup prompt.
  run                       Run approved suites and attach a proof.
  verify                    Parse and print the proof on HEAD.
  verify-chain              Fetch and verify a branch's merge chain.
  policy digest             Print policy and pipeline digests.

Run \`thwip <command> --help\` for command-specific help.
`;

const SIMPLE_HELP: Readonly<Record<Exclude<CliCommand, "queue">, string>> = {
  login: `Usage: thwip login [--endpoint URL]\n\nSign in through the thwip device authorization flow.\n`,
  ship:
    `Usage: thwip ship [--wait] [--no-queue] [--json-events]\n\n` +
    `Run approved suites, attach a proof, push, and open or update the pull request.\n`,
  init:
    `Usage: thwip init --required "lint,typecheck,test" [--profile PROFILE] [--sign-commits]\n\n` +
    `Create a repository-specific thwip.yaml override and optionally configure SSH commit signing.\n`,
  verify: `Usage: thwip verify [--json]\n\nParse and print the proof carried by HEAD.\n`,
  "verify-chain":
    `Usage: thwip verify-chain --repo OWNER/NAME [--branch BRANCH] [--epoch N]\n` +
    `       thwip verify-chain --repository-id ID [--branch BRANCH] [--epoch N]\n\n` +
    `Fetch a branch's merge chain and thwip's published keys, then verify it.\n` +
    `No thwip account is required. --repo is resolved through GitHub's public\n` +
    `API; pass --repository-id instead for a private repository or when GitHub\n` +
    `is rate limiting. --epoch pins where signature checking starts instead of\n` +
    `trusting the value the server reports.\n`,
  "keys-status":
    `Usage: thwip keys status\n\nShow which SSH key would sign and whether GitHub registers it.\n`,
  setup: `Usage: thwip setup\n\nPrint the human-guided machine setup prompt.\n`,
  run:
    `Usage: thwip run [--base REF]\n\n` +
    `Run approved suites against the committed tree and attach a signed proof to HEAD.\n`,
  "policy-digest":
    `Usage: thwip policy digest\n\nPrint the canonical policy and pipeline digests for HEAD.\n`,
};

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
  "doctor",
] as const;

type QueueSubcommand = (typeof QUEUE_SUBCOMMANDS)[number];

const QUEUE_HELP = `Usage: thwip queue <subcommand> [options]

Subcommands:
  status, list, join, leave, pause, resume, rebaseline, eject, bypass,
  explain, reconcile, doctor

Run \`thwip queue <subcommand> --help\` for its accepted options.
`;

const QUEUE_SUBCOMMAND_HELP: Readonly<Record<QueueSubcommand, string>> = {
  status: `Usage: thwip queue status --repo OWNER/NAME [--branch BRANCH] [--json] [--watch]\n`,
  list: `Usage: thwip queue list --repo OWNER/NAME [--branch BRANCH] [--json] [--watch]\n`,
  join:
    `Usage: thwip queue join --repo OWNER/NAME --pr NUMBER [--branch BRANCH] ` +
    `[--sponsor LOGIN] [--wait]\n`,
  leave: `Usage: thwip queue leave --repo OWNER/NAME --pr NUMBER [--branch BRANCH]\n`,
  pause: `Usage: thwip queue pause --repo OWNER/NAME --reason TEXT [--branch BRANCH]\n`,
  resume: `Usage: thwip queue resume --repo OWNER/NAME [--branch BRANCH] [--reason TEXT]\n`,
  rebaseline:
    `Usage: thwip queue rebaseline --repo OWNER/NAME --base-sha OID --reason TEXT ` +
    `[--branch BRANCH]\n`,
  eject:
    `Usage: thwip queue eject --repo OWNER/NAME --pr NUMBER --reason TEXT [--branch BRANCH]\n`,
  bypass:
    `Usage: thwip queue bypass --repo OWNER/NAME --pr NUMBER --reason TEXT ` +
    `--confirm OWNER/NAME#NUMBER [--branch BRANCH]\n`,
  explain:
    `Usage: thwip queue explain --repo OWNER/NAME [--branch BRANCH] [--events NUMBER] [--json]\n`,
  reconcile:
    `Usage: thwip queue reconcile --repo OWNER/NAME --observed RESULT --reason TEXT ` +
    `[--merge-sha OID] [--branch BRANCH]\n`,
  doctor: `Usage: thwip queue doctor --repo OWNER/NAME [--explain] [--strict] [--json]\n`,
};

function isQueueSubcommand(value: string | undefined): value is QueueSubcommand {
  return value !== undefined && (QUEUE_SUBCOMMANDS as readonly string[]).includes(value);
}

function wantsHelp(argv: readonly string[]): boolean {
  return argv.some((arg) => HELP_FLAGS.has(arg));
}

function error(message: string): CliAction {
  return { kind: "error", message };
}

function command(command: CliCommand, argv: readonly string[] = []): CliAction {
  return { kind: "command", invocation: { command, argv } };
}

function validateOptions(argv: readonly string[], spec: OptionSpec): string | null {
  const boolean = new Set(spec.boolean ?? []);
  const value = new Set(spec.value ?? []);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (boolean.has(token)) continue;
    if (value.has(token)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) return `${token} requires a value`;
      i += 1;
      continue;
    }
    if (token.startsWith("-")) return `unknown flag ${token}`;
    return `unexpected argument ${token}`;
  }
  return null;
}

function simpleCommand(
  commandName: Exclude<CliCommand, "queue">,
  argv: readonly string[],
  spec: OptionSpec = {},
): CliAction {
  if (wantsHelp(argv)) return { kind: "help", text: SIMPLE_HELP[commandName] };
  const invalid = validateOptions(argv, spec);
  return invalid === null ? command(commandName, argv) : error(invalid);
}

function queueCommand(argv: readonly string[]): CliAction {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || HELP_FLAGS.has(subcommand)) {
    return { kind: "help", text: QUEUE_HELP };
  }
  if (!isQueueSubcommand(subcommand)) return error(`unknown subcommand \`queue ${subcommand}\``);
  if (wantsHelp(rest)) return { kind: "help", text: QUEUE_SUBCOMMAND_HELP[subcommand] };
  const planned = planQueueCommand(argv);
  return planned.ok ? command("queue", argv) : error(planned.message);
}

function helpFor(path: readonly string[]): CliAction {
  const [name, subcommand, ...rest] = path;
  if (name === undefined || HELP_FLAGS.has(name)) return { kind: "help", text: HELP };
  if (name === "queue") {
    if (subcommand === undefined) return { kind: "help", text: QUEUE_HELP };
    if (!isQueueSubcommand(subcommand) || rest.length > 0) {
      return error(`unknown help topic ${path.join(" ")}`);
    }
    return { kind: "help", text: QUEUE_SUBCOMMAND_HELP[subcommand] };
  }
  if (name === "keys") {
    if (subcommand === undefined) return { kind: "help", text: SIMPLE_HELP["keys-status"] };
    if (subcommand === "status" && rest.length === 0) {
      return { kind: "help", text: SIMPLE_HELP["keys-status"] };
    }
    return error(`unknown help topic ${path.join(" ")}`);
  }
  if (name === "policy") {
    if (subcommand === undefined) return { kind: "help", text: SIMPLE_HELP["policy-digest"] };
    if (subcommand === "digest" && rest.length === 0) {
      return { kind: "help", text: SIMPLE_HELP["policy-digest"] };
    }
    return error(`unknown help topic ${path.join(" ")}`);
  }
  const simple = name as Exclude<CliCommand, "queue" | "keys-status" | "policy-digest">;
  if (Object.hasOwn(SIMPLE_HELP, simple) && subcommand === undefined) {
    return { kind: "help", text: SIMPLE_HELP[simple] };
  }
  return error(`unknown help topic ${path.join(" ")}`);
}

/** Plan all argument-only outcomes before any command code may run. */
export function parseCliArgs(argv: readonly string[]): CliAction {
  const [name, ...rest] = argv;
  if (name === undefined || HELP_FLAGS.has(name)) return { kind: "help", text: HELP };
  if (name === "help") return helpFor(rest);

  switch (name) {
    case "login":
      return simpleCommand("login", rest, { value: ["--endpoint"] });
    case "ship":
      return simpleCommand("ship", rest, { boolean: ["--wait", "--no-queue", "--json-events"] });
    case "queue":
      return queueCommand(rest);
    case "init":
      return simpleCommand("init", rest, {
        boolean: ["--sign-commits"],
        value: ["--required", "--profile"],
      });
    case "verify":
      return simpleCommand("verify", rest, { boolean: ["--json"] });
    case "verify-chain":
      return simpleCommand("verify-chain", rest, { value: ["--repo", "--branch", "--repository-id", "--epoch"] });
    case "keys": {
      if (rest.length === 0) return command("keys-status");
      if (wantsHelp(rest)) return { kind: "help", text: SIMPLE_HELP["keys-status"] };
      if (rest[0] !== "status") return error(`unknown subcommand \`keys ${rest[0]}\``);
      return simpleCommand("keys-status", rest.slice(1));
    }
    case "setup":
      return simpleCommand("setup", rest);
    case "run":
      return simpleCommand("run", rest, { value: ["--base"] });
    case "policy": {
      if (rest.length === 0) return error("thwip policy <digest>");
      if (wantsHelp(rest)) return { kind: "help", text: SIMPLE_HELP["policy-digest"] };
      if (rest[0] !== "digest") return error(`unknown subcommand \`policy ${rest[0]}\``);
      return simpleCommand("policy-digest", rest.slice(1));
    }
    default:
      return error(`unknown command \`${name}\``);
  }
}

/** Execute only after parsing has resolved help and usage errors. */
export async function executeCli(argv: readonly string[], ports: CliPorts): Promise<number> {
  const action = parseCliArgs(argv);
  if (action.kind === "help") {
    ports.stdout(action.text);
    return 0;
  }
  if (action.kind === "error") {
    ports.stderr(action.message + "\n");
    return EXIT.usage;
  }
  return ports.dispatch(action.invocation);
}
