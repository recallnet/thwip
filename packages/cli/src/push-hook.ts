import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { git } from "./git.js";

export const PUSH_WARNING_MARKER = "# managed by thwip push warning";

/**
 * A warning, not a second merge gate.
 *
 * GitHub remains authoritative and ordinary `git push` keeps working. This
 * catches the expensive mistake one step earlier: an outgoing branch commit
 * whose exact tree has no proof. Git supplies every outgoing local ref on
 * stdin, so this checks what is actually being pushed rather than assuming it
 * is HEAD.
 */
export function pushWarningHook(): string {
  return `#!/bin/sh
${PUSH_WARNING_MARKER}
set -u

if [ "\${THWIP_ALLOW_UNPROVEN_PUSH:-}" = "1" ]; then
  exit 0
fi

checkout=$(pwd -P)
has_thwip=1
if ! command -v thwip >/dev/null 2>&1; then
  has_thwip=0
fi

while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_ref" in
    refs/heads/*) ;;
    *) continue ;;
  esac
  case "$local_sha" in
    0000000000000000000000000000000000000000|0000000000000000000000000000000000000000000000000000000000000000) continue ;;
  esac

  if [ "$has_thwip" = "1" ]; then
    if thwip verify --commit "$local_sha" >/dev/null 2>&1; then
      continue
    fi
    proof_detail="has no accepted proof for its exact tree"
  else
    proof_detail="could not be checked because thwip is not on PATH"
  fi

  short=$(printf '%.12s' "$local_sha")
  echo "[thwip] warning: $local_ref ($short) $proof_detail" >&2
  echo "[thwip] checkout: $checkout" >&2
  echo '[thwip] run \`thwip ship --wait\` in this checkout before pushing; this push is still allowed' >&2
  echo '[thwip] intentional low-level push: THWIP_ALLOW_UNPROVEN_PUSH=1 git push ...' >&2
done

exit 0
`;
}

export type PushWarningInstall =
  | { readonly status: "installed" | "updated"; readonly path: string }
  | { readonly status: "refused"; readonly path: string; readonly detail: string };

/** Install one hook in the shared git directory used by every linked worktree. */
export async function installPushWarning(cwd: string): Promise<PushWarningInstall> {
  const named = await git(["rev-parse", "--git-path", "hooks/pre-push"], cwd);
  const unresolved = isAbsolute(named) ? named : resolve(cwd, named);
  await mkdir(dirname(unresolved), { recursive: true });
  const path = join(await realpath(dirname(unresolved)), basename(unresolved));

  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (existing !== null && !existing.includes(PUSH_WARNING_MARKER)) {
    return {
      status: "refused",
      path,
      detail: "an unmanaged pre-push hook already exists; thwip did not overwrite it",
    };
  }

  await writeFile(path, pushWarningHook(), { mode: 0o755 });
  await chmod(path, 0o755);
  return { status: existing === null ? "installed" : "updated", path };
}
