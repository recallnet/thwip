/**
 * A project's address in the dashboard.
 *
 * The URL used to be `/dashboard/projects/{project.id}`, an opaque `prj_…`
 * string only the database can read. The same row already carries
 * `github_name` — the repository's real `owner/repo` — so that is what
 * addresses the page instead. The two owner/repo segments have to be told
 * apart from an optional trailing section (`queue`, `access`, `setup`), and a
 * cold load has to parse the same path a client navigation would produce.
 */

export interface ParsedProjectPath {
  readonly githubName: string;
  readonly section: string;
}

// owner and repo each occupy exactly one path segment; a third segment, if
// present, names the section. Anchored at both ends so trailing garbage past
// the section falls through to "no match" rather than being silently eaten.
const PROJECT_PATH = /^\/dashboard\/projects\/([^/]+)\/([^/]+)(?:\/([a-z]+))?\/?$/;

export function parseProjectPath(path: string): ParsedProjectPath | null {
  const match = PROJECT_PATH.exec(path);
  if (!match) return null;
  const owner = decodeURIComponent(match[1]!);
  const repo = decodeURIComponent(match[2]!);
  if (!owner || !repo) return null;
  return { githubName: `${owner}/${repo}`, section: match[3] ?? "overview" };
}

/** Builds the address for a project, or one of its sections. */
export function projectPath(githubName: string, section?: string): string {
  const slash = githubName.indexOf("/");
  const owner = slash === -1 ? githubName : githubName.slice(0, slash);
  const repo = slash === -1 ? "" : githubName.slice(slash + 1);
  const base = `/dashboard/projects/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return section && section !== "overview" ? `${base}/${section}` : base;
}

/**
 * The dashboard already fetches the full project list for the organization;
 * this resolves the `owner/repo` named in the URL against it rather than
 * adding a lookup endpoint. GitHub repository names are case-insensitive, so
 * the match is too.
 */
export function findProjectByGithubName<T extends { github_name: string }>(
  projects: readonly T[],
  githubName: string,
): T | undefined {
  const target = githubName.toLowerCase();
  return projects.find((p) => p.github_name.toLowerCase() === target);
}
