/** The read-only identity projection used by CLI init. */
export function sessionIdentity(viewer: { readonly githubUserId: string } | null): { githubUserId: string } | null {
  return viewer === null ? null : { githubUserId: viewer.githubUserId };
}
