import { recordDigest, type Sha256 } from "@thwip/queue-protocol";
import { buildGenesisRecord, signTransitionRecord } from "./evidence.js";
import { clearAttestationChainPosition, storeAttestation } from "./attestation.js";
import type { D1Like } from "./projection.js";
import { readQueue, type RecordFromIntentDeps } from "./record-from-intent.js";
import type { QueueRouteEnv } from "./routes.js";
import type { ProjectWriteLease } from "../project-lifecycle.js";

/**
 * Open a new attested range on a branch whose early history is archaeology.
 *
 * Every finding on this repository's chain came from records written by earlier
 * versions of thwip: a link whose digest was a commit sha padded with zeroes, an
 * external transition the route could not serve, merges that landed outside the
 * lane, and five records whose cited check ran against the pull request head
 * rather than the integrated candidate. The software that wrote them is gone.
 * Repairing each one would mean healing a chain nobody is being asked to trust.
 *
 * Nothing is deleted. The records stay in `queue_attestations`, still signed,
 * still fetched by digest at `/v1/queue/records/:digest`, and the storage chain
 * runs unbroken across the boundary: the genesis names the record it follows as
 * its predecessor, the way every record does. What moves is
 * `attested_from_sequence`, which is what a verifier reads as `epochStartsAt`
 * and what the chain route now serves from. The claim becomes "this is attested
 * from here" rather than "none of that counts".
 *
 * A genesis is written at the start so the range has a root. A chain served from
 * a sequence in the middle of a table begins mid-air: the first link's
 * predecessor cannot be fetched and its starting base has to be taken on trust.
 * The genesis starts from no base at all, states the commit the branch stands
 * at, and names what the queue was configured with, which is what makes it a
 * beginning rather than a cut.
 *
 * Two gates, both borrowed from the paths that already write records. The tree
 * and parents come from GitHub rather than from the caller, and the branch is
 * asked whether it contains the commit, because a commit that exists is not a
 * commit the branch stands at.
 */

export type ReEpochRefusal =
  | "BASE_UNREADABLE"
  | "COMMIT_NOT_ON_BASE"
  | "SIGNING_REFUSED"
  | "CHAIN_MOVED"
  | "NO_QUEUE";

export type ReEpochOutcome =
  | {
      readonly status: "opened";
      readonly epochStartsAt: number;
      readonly digest: string;
      readonly baseSha: string;
      readonly previousEpochStartedAt: number;
    }
  | { readonly status: "refused"; readonly detail: string; readonly code: ReEpochRefusal };

export async function openAttestedRange<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: RecordFromIntentDeps<TEnv>,
  input: {
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly atSha: string;
    readonly actorPrincipalId: string;
    readonly reason: string;
    readonly writeLease?: ProjectWriteLease;
  },
): Promise<ReEpochOutcome> {
  const { repositoryId, baseRef, atSha } = input;
  const db = env.DB as unknown as D1Like;

  const project = await db
    .prepare(
      `SELECT attested_from_sequence AS epoch, project_id AS projectId
         FROM queue_projects WHERE github_repository_id = ? AND base_ref = ?
          AND (? IS NULL OR project_id = ?)`,
    )
    .bind(repositoryId, baseRef, input.writeLease?.projectId ?? null, input.writeLease?.projectId ?? null)
    .first<{ epoch: number; projectId: string }>();
  if (project === null) return { status: "refused", detail: "no queue for that branch", code: "NO_QUEUE" };

  const facts = await deps.commitFacts(env, repositoryId, atSha);
  if (facts === null) return { status: "refused", detail: `could not read ${atSha}`, code: "BASE_UNREADABLE" };

  const reachable = await deps.baseContainsSha(env, repositoryId, baseRef, atSha);
  if (reachable !== true) {
    return {
      status: "refused",
      detail:
        reachable === false
          ? `${baseRef} does not contain ${atSha}`
          : `${baseRef} could not be asked whether it contains ${atSha}`,
      code: "COMMIT_NOT_ON_BASE",
    };
  }

  const { snapshot } = await readQueue(env, repositoryId, baseRef);
  const head = snapshot.transitions.at(-1);
  const transitionSequence = (head?.transitionSequence ?? 0) + 1;
  const priorDigest = (head?.digest ?? null) as Sha256 | null;

  const policy = await deps.activePolicy(env, repositoryId);
  const document = await buildGenesisRecord({
    repositoryId,
    baseRef,
    queueEpoch: snapshot.queueEpoch,
    transitionSequence,
    previousTransitionDigest: priorDigest,
    at: { sha: atSha, treeOid: facts.treeOid, parentShas: facts.parentShas },
    // A queue running without an activated policy has no policy digest to name,
    // and the all-zero digest is what this codebase already writes where a
    // decision names nothing.
    policyDigest: (policy?.policyDigest ?? `sha256:${"0".repeat(64)}`) as Sha256,
    // What the range was opened with and why, bound rather than described. The
    // words the operator gave are inside the digest, so the record cannot be
    // reused for a different reason later.
    configDigest: await recordDigest({
      baseRef,
      queueEpoch: snapshot.queueEpoch,
      previousEpochStartedAt: project.epoch,
      actorPrincipalId: input.actorPrincipalId,
      reason: input.reason,
    }),
    rulesetDigest: await recordDigest({
      requiredSuites: [...(policy?.requiredSuites ?? [])],
      pipelineDigest: policy?.pipelineDigest ?? null,
    }),
    observedAt: new Date().toISOString(),
  });

  const signed = await signTransitionRecord(document, {
    sign: (bytes, typ) => deps.signRecordBytes(env, bytes, typ),
  });
  if ("error" in signed) {
    return {
      status: "refused",
      detail: `the queue refused to sign its own record: ${signed.error}`,
      code: "SIGNING_REFUSED",
    };
  }

  const stored = await storeAttestation(db, {
    digest: signed.digest,
    kind: "genesis",
    repositoryId,
    projectId: input.writeLease?.projectId ?? project.projectId,
    baseRef,
    transitionSequence,
    // Synthetic and unique to the position, so a second call for the same
    // position is refused by the partial unique index rather than taking a
    // second root. No attempt opened a range; there is nothing real to name.
    attemptId: `genesis:${transitionSequence}`,
    bytes: signed.bytes,
    jws: signed.jws,
    ...(policy === null
      ? {}
      : {
          organizationId: policy.organizationId,
          mirror: (mirrored: {
            organizationId: string;
            repositoryId: string;
            kind: "merge-intent" | "transition-record";
            digest: string;
            bytes: Uint8Array;
          }) =>
            deps
              .storeEvidence(env, {
                projectId: policy.projectId,
                ...(input.writeLease === undefined ? {} : { writeLease: input.writeLease }),
                organizationId: mirrored.organizationId,
                repositoryId: mirrored.repositoryId,
                kind: mirrored.kind,
                digest: mirrored.digest as `sha256:${string}`,
                bytes: mirrored.bytes,
              })
              .then(() => undefined),
        }),
  });
  if (!stored.stored) {
    return { status: "refused", detail: "a record already holds that position", code: "CHAIN_MOVED" };
  }

  const { result } = await deps.onQueue(env, repositoryId, baseRef, ({ commands, store }) => {
    const tail = store.state().transitions.at(-1);
    if ((tail?.transitionSequence ?? 0) + 1 !== transitionSequence || (tail?.digest ?? null) !== priorDigest) {
      return { moved: true as const };
    }
    commands.recordTransition({
      idempotencyKey: `genesis:${transitionSequence}`,
      kind: "genesis",
      transitionSequence,
      priorDigest,
      digest: signed.digest,
      baseSha: atSha,
      attemptId: null,
      witnessPrincipalIds: [input.actorPrincipalId],
    });
    return { moved: false as const };
  }, undefined, undefined, input.writeLease);

  if (result.moved) {
    // The chain grew while this was being signed. The bytes stay, because the
    // queue really did sign them, and what goes is the claim to a position.
    await clearAttestationChainPosition(db, signed.digest, input.writeLease?.projectId ?? project.projectId);
    return { status: "refused", detail: "the chain moved while this record was being signed; try again", code: "CHAIN_MOVED" };
  }

  // Last, and only once the genesis holds its position. Raising the epoch first
  // and then failing to write the root would leave a chain served from a
  // sequence with nothing at it, which is the mid-air start this exists to
  // avoid.
  await db
    .prepare(
      `UPDATE queue_projects SET attested_from_sequence = ?
        WHERE github_repository_id = ? AND base_ref = ? AND project_id = ?
          AND EXISTS (SELECT 1 FROM projects p WHERE p.id = queue_projects.project_id)`,
    )
    .bind(transitionSequence, repositoryId, baseRef, input.writeLease?.projectId ?? project.projectId)
    .run();

  return {
    status: "opened",
    epochStartsAt: transitionSequence,
    digest: signed.digest,
    baseSha: atSha,
    previousEpochStartedAt: project.epoch,
  };
}
