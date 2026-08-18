import { readFileSync } from "node:fs";

export const DEFAULT_ENDPOINT = "https://thwip.ai";

export interface ActionInputs {
  readonly endpoint: string;
  readonly githubToken: string;
  readonly githubApiUrl: string;
}

export interface PullRequestContext {
  readonly kind: "pull_request";
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly baseRefName: string;
  readonly headSha: string;
  readonly authorGithubUserId: string;
  readonly draft: boolean;
  readonly runId: string | null;
}

export interface CandidateReportContext {
  readonly kind: "candidate_report";
  readonly repositoryId: string;
  readonly dispatchNonce: string;
  readonly expectedWorkflowSha: string;
  readonly actualWorkflowSha: string;
}

export type ActionContext = PullRequestContext | CandidateReportContext;

type Env = Readonly<Record<string, string | undefined>>;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is missing or malformed`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is missing or malformed`);
  return value;
}

function id(value: unknown, name: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
    throw new Error(`${name} is missing or malformed`);
  }
  return String(value);
}

function pullRequestContext(event: Record<string, unknown>, env: Env): PullRequestContext {
  const repository = record(event["repository"], "repository");
  const owner = record(repository["owner"], "repository.owner");
  const pullRequest = record(event["pull_request"], "pull_request");
  const base = record(pullRequest["base"], "pull_request.base");
  const head = record(pullRequest["head"], "pull_request.head");
  const author = record(pullRequest["user"], "pull_request.user");
  const number = pullRequest["number"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("pull_request.number is missing or malformed");
  }
  const draft = pullRequest["draft"];
  if (typeof draft !== "boolean") throw new Error("pull_request.draft is missing or malformed");
  return {
    kind: "pull_request",
    repositoryId: id(repository["id"], "repository.id"),
    repositoryOwnerId: id(owner["id"], "repository.owner.id"),
    repository: string(repository["full_name"], "repository.full_name"),
    pullRequestNumber: number,
    baseRefName: string(base["ref"], "pull_request.base.ref"),
    headSha: string(head["sha"], "pull_request.head.sha"),
    authorGithubUserId: id(author["id"], "pull_request.user.id"),
    draft,
    runId: env["GITHUB_RUN_ID"] ?? null,
  };
}

function candidateReportContext(event: Record<string, unknown>, env: Env): CandidateReportContext {
  if (event["action"] !== "thwip-queue-verify") {
    throw new Error(`unsupported repository_dispatch action ${String(event["action"] ?? "")}`);
  }
  const repository = record(event["repository"], "repository");
  const payload = record(event["client_payload"], "client_payload");
  return {
    kind: "candidate_report",
    repositoryId: id(repository["id"], "repository.id"),
    dispatchNonce: string(payload["dispatchNonce"], "client_payload.dispatchNonce"),
    expectedWorkflowSha: string(payload["workflowCommitSha"], "client_payload.workflowCommitSha"),
    actualWorkflowSha: string(env["GITHUB_WORKFLOW_SHA"], "GITHUB_WORKFLOW_SHA"),
  };
}

export function readActionContext(env: Env = process.env): ActionContext {
  const eventName = string(env["GITHUB_EVENT_NAME"], "GITHUB_EVENT_NAME");
  const eventPath = string(env["GITHUB_EVENT_PATH"], "GITHUB_EVENT_PATH");
  const event = record(JSON.parse(readFileSync(eventPath, "utf8")), "event payload");
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return pullRequestContext(event, env);
  }
  if (eventName === "repository_dispatch") return candidateReportContext(event, env);
  throw new Error(`unsupported event ${eventName}`);
}

export function readActionInputs(env: Env = process.env): ActionInputs {
  const rawEndpoint = env["INPUT_ENDPOINT"]?.trim() || DEFAULT_ENDPOINT;
  const endpoint = new URL(rawEndpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.pathname !== "/"
  ) {
    throw new Error("endpoint must be an HTTPS origin");
  }
  return {
    endpoint: endpoint.origin,
    githubToken: env["INPUT_GITHUB-TOKEN"]?.trim() ?? "",
    githubApiUrl: env["GITHUB_API_URL"]?.trim() || "https://api.github.com",
  };
}
