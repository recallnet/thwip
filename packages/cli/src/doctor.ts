import { EXIT, exitCodeFor, nextActionFor, type ExitCode, type ReasonCode } from "./queue-exit.js";
import { reportDoctor, type CheckStatus, type DoctorObservation } from "./queue-doctor.js";

/**
 * `thwip doctor`: can this project produce a proof and have it verified
 * remotely, from this machine, under the configuration it has right now.
 *
 * Nothing here probes anything new. The session, the signing key and the policy
 * digests are the reads `thwip keys status` and `thwip policy digest` already
 * make; the repository, the queue and the App are the three `thwip queue
 * doctor` already makes. Onboarding failed one control at a time, in whatever
 * order somebody happened to run the commands, and the last of them turned up
 * after a signed proof had already been pushed. This runs them together and
 * answers once.
 *
 * Every check is pass, fail, or unread, and the exit code is zero only when
 * every check passed. An unread check is the whole reason this command was
 * rewritten: a probe that could not look is not a probe that found nothing
 * wrong. `--allow-unread` is the explicit way to spend one, and it spends only
 * the checks a caller has no standing to read.
 *
 * `facts` carries what a check actually read and nothing else. A field with no
 * producer is worse than a missing field, because a reader believes it: this
 * repository shipped `appPermissionsHealthy` and `rulesetEnforced` as declared
 * fields nothing ever wrote, and every branch on them took its default forever.
 */

export type DoctorCheckName = "session" | "signing-key" | "policy" | "repository" | "queue" | "app";

export interface DoctorCheck {
  readonly check: DoctorCheckName;
  readonly status: CheckStatus;
  readonly reasonCode: ReasonCode;
  readonly facts: Record<string, unknown>;
  readonly lines: readonly string[];
  readonly exitCode: ExitCode;
}

/** What the signing key on this machine is, as `thwip keys status` reads it. */
export type SigningKeyRead =
  | { readonly kind: "registered"; readonly fingerprint: string; readonly path: string }
  | { readonly kind: "unregistered"; readonly fingerprint: string; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unread"; readonly detail: string };

/** The policy in force for HEAD, as `thwip policy digest` reads it. */
export type PolicyRead =
  | {
      readonly kind: "read";
      readonly policyDigest: string;
      readonly pipelineDigest: string;
      readonly version: number;
      readonly requiredSuites: readonly string[];
      readonly configSource: string;
    }
  | { readonly kind: "unread"; readonly detail: string };

export interface LocalReads {
  readonly session: "signed-in" | "signed-out";
  readonly signingKey: SigningKeyRead;
  readonly policy: PolicyRead;
}

export interface DoctorFullReport {
  readonly checks: readonly DoctorCheck[];
  readonly lines: readonly string[];
  readonly exitCode: ExitCode;
}

/** Worst first, so a reader gets the worst thing doctor found. */
const SEVERITY: ExitCode[] = [
  EXIT.authRequired,
  EXIT.setupInvalid,
  EXIT.permission,
  EXIT.evidenceRejected,
  EXIT.unavailable,
  EXIT.invariant,
  EXIT.ok,
];

function worst(codes: readonly ExitCode[]): ExitCode {
  return SEVERITY.find((code) => codes.includes(code)) ?? EXIT.invariant;
}

function check(
  name: DoctorCheckName,
  status: CheckStatus,
  reasonCode: ReasonCode,
  facts: Record<string, unknown>,
  lines: readonly string[],
): DoctorCheck {
  return { check: name, status, reasonCode, facts, lines, exitCode: exitCodeFor(reasonCode) };
}

function sessionCheck(local: LocalReads): DoctorCheck {
  if (local.session === "signed-out") {
    return check("session", "fail", "LOGIN_REQUIRED", { signedIn: false }, [
      `Session: ${nextActionFor("LOGIN_REQUIRED")}`,
    ]);
  }
  return check("session", "pass", "PASS", { signedIn: true }, ["Session: signed in to the control plane."]);
}

function signingKeyCheck(local: LocalReads): DoctorCheck {
  const key = local.signingKey;
  if (key.kind === "unread") {
    return check("signing-key", "unread", "LOCAL_FAILURE", { detail: key.detail }, [
      `Signing key: could not be read (${key.detail}).`,
    ]);
  }
  if (key.kind === "missing") {
    return check("signing-key", "fail", "DEVICE_NOT_ENROLLED", { found: false }, [
      "Signing key: none on this machine. ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519",
    ]);
  }
  const facts = {
    found: true,
    fingerprint: key.fingerprint,
    privateKeyPath: key.path,
    registeredWithGithub: key.kind === "registered",
  };
  if (key.kind === "unregistered") {
    return check("signing-key", "fail", "SIGNER_KEY_UNKNOWN", facts, [
      `Signing key: ${key.fingerprint} is not registered with GitHub, so nothing it signs can be attributed.`,
      `  gh ssh-key add ${key.path}.pub --type signing`,
    ]);
  }
  return check("signing-key", "pass", "PASS", facts, [`Signing key: ${key.fingerprint}, registered with GitHub.`]);
}

function policyCheck(local: LocalReads): DoctorCheck {
  const policy = local.policy;
  if (policy.kind === "unread") {
    return check("policy", "unread", "LOCAL_FAILURE", { detail: policy.detail }, [
      `Policy: could not be read (${policy.detail}), so nothing knows what a proof here has to cover.`,
    ]);
  }
  return check(
    "policy",
    "pass",
    "PASS",
    {
      policyDigest: policy.policyDigest,
      pipelineDigest: policy.pipelineDigest,
      version: policy.version,
      requiredSuites: policy.requiredSuites,
      configSource: policy.configSource,
    },
    [
      `Policy: v${policy.version} from ${policy.configSource}, ${policy.policyDigest}.`,
      `  Required suites: ${policy.requiredSuites.length === 0 ? "none" : policy.requiredSuites.join(", ")}`,
    ],
  );
}

/**
 * Every check, and the one exit code that answers for all of them.
 *
 * The remote three come from `reportDoctor` rather than a second copy of the
 * same status handling, so `thwip doctor` and `thwip queue doctor` cannot
 * disagree about what a 403 on the App section means.
 */
export function runDoctor(input: {
  readonly local: LocalReads;
  readonly observations: readonly DoctorObservation[];
  readonly repo: string;
  readonly ref: string;
  readonly allowUnread: boolean;
}): DoctorFullReport {
  const remote = reportDoctor(input.observations, {
    repo: input.repo,
    ref: input.ref,
    allowUnread: input.allowUnread,
  });

  const checks: DoctorCheck[] = [
    sessionCheck(input.local),
    signingKeyCheck(input.local),
    policyCheck(input.local),
    ...remote.sections.map((section) =>
      check(section.section, section.status, section.reasonCode, section.facts, section.lines),
    ),
  ];

  const codes = checks.map((one) => {
    // The same bargain `thwip queue doctor` strikes: not being a repository
    // admin is a fact about the caller and may be waived, and nothing else may.
    const forgiven = input.allowUnread && one.status === "unread" && one.exitCode === EXIT.permission;
    return forgiven ? EXIT.ok : one.exitCode;
  });

  return { checks, lines: checks.flatMap((one) => one.lines), exitCode: worst(codes) };
}
