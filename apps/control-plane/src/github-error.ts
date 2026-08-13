/**
 * A refusal from GitHub, with the status still attached.
 *
 * Every helper here used to throw a plain Error whose message happened to
 * contain the status. A caller that wanted to tell "the App lacks this
 * permission" from "GitHub had a bad minute" had to read prose, so none of them
 * did, and a 403 on a pull-request read came back to an operator as an internal
 * error with no idea which permission was missing.
 */
export class GithubApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    super(`GitHub ${path} -> ${status}: ${body.slice(0, 500)}`);
    this.name = "GithubApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** A GitHub throttle response whose retry boundary is safe to carry onto the queue. */
export class GithubRateLimitError extends GithubApiError {
  readonly retryAfterSeconds: number;

  constructor(path: string, status: number, body: string, retryAfterSeconds: number) {
    super(path, status, body);
    this.name = "GithubRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The status of a failure, from the object if it carries one and the message if not. */
export function githubStatusOf(error: unknown): number | null {
  if (error instanceof GithubApiError) return error.status;
  if (error instanceof Error) {
    const match = /^GitHub .* -> (\d{3})\b/.exec(error.message);
    if (match !== null) return Number(match[1]);
  }
  return null;
}
