/** GitHub's fixed issuer for Actions identity tokens. */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export interface GithubOidcAudienceEnv {
  readonly PUBLIC_ORIGIN: string;
  /** Temporary hostname accepted while enrolled workflows move to PUBLIC_ORIGIN. */
  readonly LEGACY_ORIGIN?: string;
}

function githubActionsAudience(origin: string): string {
  return `${origin}/api/github-actions`;
}

/**
 * Audiences accepted from GitHub Actions during a hostname transition.
 *
 * A missing or duplicate legacy origin keeps the ordinary one-audience gate.
 * Once every enrolled workflow uses PUBLIC_ORIGIN, removing LEGACY_ORIGIN
 * closes the transition without another code change.
 */
export function githubOidcAudiences(env: GithubOidcAudienceEnv): string | [string, string] {
  const current = githubActionsAudience(env.PUBLIC_ORIGIN);
  const legacyOrigin = env.LEGACY_ORIGIN?.trim();
  if (!legacyOrigin) return current;

  const legacy = githubActionsAudience(legacyOrigin);
  return legacy === current ? current : [current, legacy];
}
