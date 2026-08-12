/** GitHub's fixed issuer for Actions identity tokens. */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export interface GithubOidcAudienceEnv {
  readonly PUBLIC_ORIGIN: string;
}

/** The one audience accepted from GitHub Actions. */
export function githubOidcAudience(env: GithubOidcAudienceEnv): string {
  return `${env.PUBLIC_ORIGIN}/api/github-actions`;
}
