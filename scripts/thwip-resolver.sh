#!/bin/sh
#
# Which thwip does a bare `thwip` run.
#
# It used to run whichever one a symlink pointed at. On a machine with several
# worktrees that meant every session ran one worktree's `dist`, whatever branch
# the session was on, so a person editing CLI code was never running the code
# they had edited. A bug in `thwip ship` survived a full day of use that way: it
# reported a queued pull request that did not exist, and every run that hit it
# came from a build nobody was reading.
#
# So resolution is decided per invocation instead of being frozen into a link:
#
#   inside a thwip checkout   that checkout's build
#   anywhere else             the published release
#
# Both halves are predictable, and neither depends on which worktree happens to
# exist. Install this file at the `thwip` on your PATH; the README says how.
#
# A checkout with no build falls back to the release and says so. It used to
# stop, which meant a fresh clone of thwip broke the first command a new
# contributor ran. Falling back silently is the bug family this repository keeps
# finding, so the fallback is announced and `thwip version` names the build that
# answered.
#
# Nothing here reaches the network. `thwip --version` fetching a package is a
# surprise nobody asked for, so a missing release is reported with the command
# that fixes it. scripts/install-thwip.mjs is what installs.
set -eu

release_home="${THWIP_RELEASE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/thwip/release}"

# Walk up for a checkout that builds its own thwip. `.git` is a file rather than
# a directory in a worktree, so presence is what is asked about. The package
# name is read too: another project's packages/cli is not this one.
dir=$(pwd -P)
while :; do
  if [ -e "$dir/.git" ] &&
    grep -q '"name"[[:space:]]*:[[:space:]]*"@thwip/cli"' "$dir/packages/cli/package.json" 2>/dev/null; then
    build="$dir/packages/cli/dist/main.js"
    if [ -f "$build" ]; then
      exec node "$build" "$@"
    fi
    echo "thwip: $dir has no build yet, so this is the published release. Run \`pnpm build\` there to use its own." >&2
    break
  fi
  parent=$(dirname "$dir")
  if [ "$parent" = "$dir" ]; then break; fi
  dir="$parent"
done

# Outside a checkout, the published release, kept in one place of its own so no
# repository owns it and no worktree can take it away by being deleted.
bundle="$release_home/node_modules/@recallnet/thwip/thwip.mjs"
if [ ! -f "$bundle" ]; then
  echo "thwip: no release installed at $release_home. Install it with:" >&2
  echo "  npm install --prefix \"$release_home\" @recallnet/thwip" >&2
  exit 12
fi
exec node "$bundle" "$@"
