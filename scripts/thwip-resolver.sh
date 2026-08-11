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
# A checkout with no build stops with the exact build command. Falling back to
# the release still runs code from somewhere other than the checkout, even when
# it says so, which is the mismatch this resolver exists to prevent.
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
    echo "thwip: $dir has no checkout build at $build." >&2
    echo 'thwip: repair it with: pnpm --dir "$(git rev-parse --show-toplevel)" build' >&2
    echo "thwip: then retry the same thwip command from this checkout." >&2
    exit 12
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
