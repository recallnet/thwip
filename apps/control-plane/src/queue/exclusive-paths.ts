import { exclusivePathMatches } from "@thwip/policy";

/** The fields that distinguish one non-directory Git tree entry from another. */
export interface GitTreeEntry {
  readonly path?: string;
  readonly mode?: string;
  readonly type?: string;
  readonly sha?: string;
}

export type CandidatePathChanges =
  | { readonly status: "exact"; readonly paths: readonly string[] }
  | { readonly status: "unreadable"; readonly detail: string };

function fileEntries(entries: readonly GitTreeEntry[]): Map<string, string> | null {
  const files = new Map<string, string>();
  const seenPaths = new Set<string>();
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      (entry.type !== "blob" && entry.type !== "commit" && entry.type !== "tree") ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.includes("\0") ||
      entry.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      typeof entry.mode !== "string" ||
      typeof entry.sha !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.sha) ||
      (entry.type === "tree" && entry.mode !== "040000") ||
      (entry.type === "commit" && entry.mode !== "160000") ||
      (entry.type === "blob" && !["100644", "100755", "120000"].includes(entry.mode)) ||
      seenPaths.has(entry.path)
    ) {
      return null;
    }
    seenPaths.add(entry.path);
    if (entry.type === "tree") continue;
    files.set(entry.path, `${entry.mode}:${entry.type}:${entry.sha}`);
  }
  return files;
}

/**
 * Find the exact repository paths changed from the current base tree to the
 * combined candidate tree. A rename is one deletion and one addition, so both
 * names are checked. Mode-only changes and gitlinks count too.
 */
export function changedPathsBetweenTrees(
  baseEntries: readonly GitTreeEntry[],
  candidateEntries: readonly GitTreeEntry[],
): CandidatePathChanges {
  const base = fileEntries(baseEntries);
  const candidate = fileEntries(candidateEntries);
  if (base === null || candidate === null) {
    return { status: "unreadable", detail: "GitHub returned a malformed or ambiguous recursive tree" };
  }
  const paths = [...new Set([...base.keys(), ...candidate.keys()])]
    .filter((path) => base.get(path) !== candidate.get(path))
    .sort();
  return { status: "exact", paths };
}

/** Whether any combined-candidate change enters a policy's exclusive region. */
export function matchingExclusivePaths(
  changedPaths: readonly string[],
  patterns: readonly string[],
): string[] {
  return changedPaths.filter((path) => patterns.some((pattern) => exclusivePathMatches(pattern, path)));
}
