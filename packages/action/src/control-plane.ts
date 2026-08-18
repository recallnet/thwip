export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly text: string;
}

export interface ActionClientOptions {
  readonly endpoint: string;
  readonly githubApiUrl: string;
  readonly githubToken: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly log?: (message: string) => void;
}

export interface QueueAuthorization {
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly authorGithubUserId: string;
  readonly draft: boolean;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function bodyText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export class ActionClient {
  readonly #endpoint: string;
  readonly #githubApiUrl: string;
  readonly #githubToken: string;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #log: (message: string) => void;
  #oidcToken: Promise<string> | undefined;

  constructor(options: ActionClientOptions) {
    this.#endpoint = options.endpoint;
    this.#githubApiUrl = options.githubApiUrl;
    this.#githubToken = options.githubToken;
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? delay;
    this.#log = options.log ?? console.log;
  }

  async github<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (this.#githubToken === "") throw new Error("github-token is required for pull-request verification");
    const response = await this.#fetch(`${this.#githubApiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#githubToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "thwip-action",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
    return response.json() as Promise<T>;
  }

  async controlPlane<T>(path: string, body: unknown): Promise<HttpResponse<T>> {
    const response = await this.#fetch(`${this.#endpoint}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.#getOidcToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = text;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed as T, text };
  }

  async authorize(input: QueueAuthorization): Promise<string> {
    const body = {
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.headSha,
      baseRef: input.baseRef,
      authorGithubUserId: input.authorGithubUserId,
      draft: input.draft,
    };
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await this.controlPlane<Record<string, unknown>>(
        `/v1/queue/${input.repositoryId}/authorize`,
        body,
      );
      if (response.status === 200) {
        const reason = response.body["reason"];
        return typeof reason === "string" ? reason : "UNKNOWN";
      }
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 6) {
        throw new Error(`queue authorization returned ${response.status}: ${bodyText(response.body)}`);
      }
      const wait = attempt * 15_000;
      this.#log(`Thwip Queue returned ${response.status}; retrying in ${wait / 1000}s`);
      await this.#sleep(wait);
    }
    throw new Error("queue authorization did not complete");
  }

  async reportCandidate(input: {
    repositoryId: string;
    dispatchNonce: string;
    expectedWorkflowSha: string;
    actualWorkflowSha: string;
  }): Promise<void> {
    if (input.actualWorkflowSha !== input.expectedWorkflowSha) {
      throw new Error("the verifier did not start from the dispatched workflow commit");
    }
    const response = await this.controlPlane(`/v1/queue/${input.repositoryId}/candidate-result`, {
      dispatchNonce: input.dispatchNonce,
    });
    if (response.status !== 202) {
      throw new Error(`candidate report returned ${response.status}: ${bodyText(response.body)}`);
    }
  }

  async #getOidcToken(): Promise<string> {
    this.#oidcToken ??= this.#requestOidcToken();
    return this.#oidcToken;
  }

  async #requestOidcToken(): Promise<string> {
    const requestUrl = this.#env["ACTIONS_ID_TOKEN_REQUEST_URL"];
    const requestToken = this.#env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
    if (!requestUrl || !requestToken) throw new Error("OIDC is unavailable; grant id-token: write");
    const url = new URL(requestUrl);
    url.searchParams.set("audience", `${this.#endpoint}/api/github-actions`);
    const response = await this.#fetch(url, {
      headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(`OIDC token request returned ${response.status}`);
    const body = (await response.json()) as { value?: unknown };
    if (typeof body.value !== "string" || body.value === "") {
      throw new Error("OIDC token response contained no token");
    }
    return body.value;
  }
}
