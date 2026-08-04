import { b64stdEncode, encodeCarrier, utf8Encode } from "@thwip/protocol";

/**
 * A commit message carrying a readable proof, as a shipped head carries one.
 *
 * The merge gate reads what the proof bound, so the payload is a real predicate
 * rather than an empty statement: the policy and the pipeline it satisfied, and
 * the suites it ran. Five test files each held their own copy of one such
 * message, pasted as a single line of base64 nobody could read or change, and a
 * gate that started reading a new field would have needed all five regenerated
 * by hand.
 */
export function provenCommit(
  over: {
    repositoryId?: string;
    baseRef?: string;
    treeOid?: string;
    baseSha?: string;
    policyDigest?: string;
    pipelineDigest?: string;
    suites?: Array<{ id: string; status: "passed" | "failed" }>;
    subject?: string;
  } = {},
): string {
  const treeOid = over.treeOid ?? "7".repeat(40);
  const baseSha = over.baseSha ?? "b".repeat(40);
  const baseRef = over.baseRef ?? "refs/heads/main";
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "git-tree", digest: { sha1: treeOid } }],
    predicateType: "urn:thwip:attestation:ci-run:v1",
    predicate: {
      schemaVersion: "1",
      repository: { provider: "github", ownerId: "1", repositoryId: over.repositoryId ?? "1315419165" },
      git: {
        objectFormat: "sha1",
        treeOid,
        parentOids: [baseSha],
        baseRef,
        baseSha,
        evaluationMode: "head-tree",
      },
      policy: { digest: over.policyDigest ?? `sha256:${"b".repeat(64)}`, version: 1 },
      pipeline: { digest: over.pipelineDigest ?? `sha256:${"c".repeat(64)}`, runner: "command" },
      run: {
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
        networkMode: "disabled",
        cacheMode: "disabled",
        suites: (over.suites ?? [{ id: "unit", status: "passed" as const }]).map((s) => ({
          ...s,
          durationMs: 1,
        })),
      },
      signer: { keyId: `SHA256:${"k".repeat(43)}`, githubUserId: "1" },
    },
  };
  const envelope = {
    payloadType: "application/vnd.in-toto+json",
    payload: b64stdEncode(utf8Encode(JSON.stringify(statement))),
    signatures: [{ keyid: `SHA256:${"k".repeat(43)}`, sig: "AAAA" }],
  };
  return `${over.subject ?? "feat: something"}\n\n${encodeCarrier(envelope as never)}\n`;
}
