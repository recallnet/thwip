import { runOnQueue, type QueueRouteEnv } from "./routes.js";

/**
 * Tell the queue its branch moved without it.
 *
 * Pausing is the point: every turn the queue has offered was against a base that
 * no longer exists, so it stops and waits for an administrator to rebaseline
 * rather than merge onto a tree nobody checked.
 *
 * Applying the same observation twice is harmless — the command is keyed by the
 * sha, so a redelivered webhook is a duplicate rather than a second pause — and
 * a branch the queue does not manage is ignored rather than treated as an error.
 */
export async function queueExternalMove(
  env: QueueRouteEnv,
  move: { repositoryId: string; baseRef: string; observedBaseSha: string },
): Promise<{ handled: boolean; detail: string }> {
  const project = await env.DB.prepare(
    "SELECT activation_state FROM queue_projects WHERE github_repository_id = ? AND base_ref = ? AND enabled = 1",
  )
    .bind(move.repositoryId, move.baseRef)
    .first<{ activation_state: string }>();
  if (project === null) return { handled: false, detail: "no queue configured for this branch" };

  const { result } = await runOnQueue(env, move.repositoryId, move.baseRef, ({ commands, store }) => {
    // Already where the queue thinks it is: this is its own merge coming back
    // round, or the same delivery twice.
    if (store.state().baseSha === move.observedBaseSha) return { status: "noop" as const };
    return commands.observedExternalTransition({
      idempotencyKey: `external:${move.observedBaseSha}`,
      observedBaseSha: move.observedBaseSha,
    });
  });

  return {
    handled: result.status === "applied",
    detail:
      result.status === "applied"
        ? `paused: ${move.baseRef} moved to ${move.observedBaseSha} outside the queue`
        : `no change (${result.status})`,
  };
}
