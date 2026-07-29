import {
  DSSE_PAYLOAD_TYPE,
  PREDICATE_TYPE,
  SSH_SIGN_NAMESPACE,
  STATEMENT_TYPE,
  b64stdEncode,
  dssePae,
  encodeCarrier,
  utf8Encode,
  type DsseEnvelope,
  type InTotoStatementV1,
  type Sha256,
  type SuiteResult,
} from "@thwip/protocol";
import { signSsh } from "@thwip/sshsig";
import type { GitSubject } from "./git.js";

export interface ProofInputs {
  subject: GitSubject;
  ownerId: string;
  repositoryId: string;
  policyDigest: Sha256;
  policyVersion: number;
  pipelineDigest: Sha256;
  runner: "command" | "dagger";
  suites: SuiteResult[];
  startedAt: string;
  finishedAt: string;
  keyId: string;
  githubUserId: string;
  privateKeyPath: string;
  lease?: string;
}

export function buildStatement(i: ProofInputs): InTotoStatementV1 {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: "git-tree", digest: { [i.subject.objectFormat]: i.subject.treeOid } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      schemaVersion: "1",
      repository: { provider: "github", ownerId: i.ownerId, repositoryId: i.repositoryId },
      git: {
        objectFormat: i.subject.objectFormat,
        treeOid: i.subject.treeOid,
        parentOids: i.subject.parentOids,
        baseRef: i.subject.baseRef,
        baseSha: i.subject.baseSha,
        evaluationMode: "head-tree",
      },
      policy: { digest: i.policyDigest, version: i.policyVersion },
      pipeline: { digest: i.pipelineDigest, runner: i.runner },
      run: {
        startedAt: i.startedAt,
        finishedAt: i.finishedAt,
        ...(i.lease !== undefined ? { lease: i.lease } : {}),
        networkMode: "unrestricted",
        cacheMode: "read-write",
        suites: i.suites,
      },
      signer: { keyId: i.keyId, githubUserId: i.githubUserId },
    },
  };
}

export async function signStatement(
  statement: InTotoStatementV1,
  keyId: string,
  privateKeyPath: string,
): Promise<DsseEnvelope> {
  const payloadBytes = utf8Encode(JSON.stringify(statement));
  const pae = dssePae(DSSE_PAYLOAD_TYPE, payloadBytes);
  const sig = await signSsh({ privateKeyPath, namespace: SSH_SIGN_NAMESPACE, message: pae });
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: b64stdEncode(payloadBytes),
    signatures: [{ keyid: keyId, sig }],
  };
}

/** Append the single thwip trailer to a commit message, replacing any prior one. */
export function attachTrailer(message: string, envelope: DsseEnvelope): string {
  const stripped = message
    .split("\n")
    .filter((l) => !l.startsWith("thwip-proof:"))
    .join("\n")
    .replace(/\n+$/, "");
  return `${stripped}\n\n${encodeCarrier(envelope)}\n`;
}
