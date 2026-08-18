export interface SetupFile {
  readonly path: string;
  readonly content: string;
}

export const SETUP_BRANCH = "thwip/setup";
export const SETUP_PULL_REQUEST_TITLE = "Set up Thwip Queue" as const;
export const QUEUE_ACTION_REF = "recallnet/thwip@c9e23c740ffe7d7f30123e829787647443007f7b";

const HOSTED_ENDPOINT = "https://thwip.ai";

const THWIP_YAML = `# Repository-specific Thwip settings
version: 4
profile: fast
required:
  - lint
  - typecheck
  - test
`;

const PUBLISHED_ACTION_STEP = `      - name: Verify the proof and join Thwip Queue
        uses: __ACTION_REF____ACTION_INPUTS__`;

const REQUIRED_WORKFLOW = `name: thwip

run-name: >-
  thwip: verify proof for PR #\${{ github.event.pull_request.number }} —
  \${{ github.event.pull_request.title }}

on:
  pull_request:

permissions:
  contents: read
  id-token: write
  checks: write
  pull-requests: read

jobs:
  thwip:
    name: thwip / workflow
    runs-on: ubuntu-latest
    steps:
__ACTION_STEPS__
`;

const VERIFY_WORKFLOW = `name: thwip-queue-verify

# Thwip verifier callback protocol: 3

run-name: >-
  thwip: verify candidate \${{ github.event.client_payload.candidateSha }}
  for PR #\${{ github.event.client_payload.pullRequestNumber }}

on:
  repository_dispatch:
    types: [thwip-queue-verify]

jobs:
  prepare:
    name: prepare trusted suite matrix
    runs-on: ubuntu-latest
    permissions: {}
    outputs:
      suites: \${{ steps.suites.outputs.suites }}
    steps:
      - name: Validate the required suite list
        id: suites
        env:
          REQUIRED_SUITES: \${{ toJSON(github.event.client_payload.requiredSuites) }}
        run: |
          node <<'NODE'
          const suites = JSON.parse(process.env.REQUIRED_SUITES ?? "null");
          if (!Array.isArray(suites) || suites.length === 0 || suites.length > 32) {
            throw new Error("the dispatch must name between 1 and 32 required suites");
          }
          const valid = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
          if (suites.some((suite) => typeof suite !== "string" || !valid.test(suite))) {
            throw new Error("the dispatch contains an invalid required suite id");
          }
          if (new Set(suites).size !== suites.length) {
            throw new Error("the dispatch contains a duplicate required suite id");
          }
          require("node:fs").appendFileSync(process.env.GITHUB_OUTPUT, "suites=" + JSON.stringify(suites) + "\\n");
          NODE

  verify:
    name: verify candidate / \${{ matrix.suite }}
    needs: prepare
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      # Candidate code must not receive OIDC or write permission.
      contents: read
    strategy:
      fail-fast: false
      matrix:
        suite: \${{ fromJSON(needs.prepare.outputs.suites) }}
    steps:
      - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
        with:
          ref: \${{ github.event.client_payload.candidateSha }}
          persist-credentials: false

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 24

      - uses: pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda # v4.1.0

      - name: Confirm the candidate tree
        env:
          EXPECTED_TREE: \${{ github.event.client_payload.candidateTreeOid }}
        run: |
          actual=$(git rev-parse "HEAD^{tree}")
          test "$actual" = "$EXPECTED_TREE"

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      - name: Run required suite
        env:
          NODE_OPTIONS: --max-old-space-size=4096
          SUITE: \${{ matrix.suite }}
        run: pnpm run "$SUITE"

  report:
    name: register trusted candidate report
    needs: [prepare, verify]
    if: \${{ always() && needs.prepare.result == 'success' }}
    runs-on: ubuntu-latest
    permissions:
      # This job receives no candidate files or outputs.
      id-token: write
    steps:
      - name: Register the candidate report with Thwip Queue
        uses: __ACTION_REF____ACTION_INPUTS__
`;

export interface SetupPullRequestInput {
  readonly endpoint: string;
  readonly actionRef: string;
  readonly includeRepositoryConfig?: boolean;
}

function actionInputs(endpoint: string): string {
  if (endpoint === HOSTED_ENDPOINT) return "";
  return `\n        with:\n          endpoint: ${JSON.stringify(endpoint)}`;
}

function render(template: string, input: SetupPullRequestInput): string {
  return template
    .replaceAll("__ACTION_STEPS__", PUBLISHED_ACTION_STEP)
    .replaceAll("__ACTION_INPUTS__", actionInputs(input.endpoint))
    .replaceAll("__ACTION_REF__", input.actionRef);
}

export function setupPullRequestFiles(input: SetupPullRequestInput): readonly SetupFile[] {
  return [
    requiredWorkflowFile(input),
    verifierWorkflowFile(input),
    ...(input.includeRepositoryConfig === true ? [{ path: "thwip.yaml", content: THWIP_YAML }] : []),
  ];
}

function requiredWorkflowFile(input: SetupPullRequestInput): SetupFile {
  return { path: ".github/workflows/thwip-required.yml", content: render(REQUIRED_WORKFLOW, input) };
}

export function verifierWorkflowFile(input: SetupPullRequestInput): SetupFile {
  return { path: ".github/workflows/thwip-queue-verify.yml", content: render(VERIFY_WORKFLOW, input) };
}

export function verifierUpgradePullRequestBody(input: SetupPullRequestInput): string {
  return [
    "This updates the reviewed Thwip Queue verifier workflow.",
    "",
    "Candidate code runs without OIDC or write permission. A separate job reports only the dispatch nonce.",
    `The workflow reports to ${input.endpoint}.`,
  ].join("\n");
}

export function setupPullRequestBody(input: SetupPullRequestInput): string {
  return [
    "This pull request adds the two workflows Thwip Queue needs.",
    "",
    "- `thwip-required.yml` verifies each pull request and joins the queue.",
    "- `thwip-queue-verify.yml` tests the integrated candidate when the active profile requires it.",
    ...(input.includeRepositoryConfig === true
      ? ["- `thwip.yaml` contains the repository override selected during setup."]
      : ["- No `thwip.yaml` is added. The repository inherits the organization defaults."]),
    "",
    "The installed App performs the merge. It needs repository contents access and workflow access when a merge changes Actions files. It does not need repository administration access or a merge token.",
    `The workflows report to ${input.endpoint}.`,
  ].join("\n");
}
