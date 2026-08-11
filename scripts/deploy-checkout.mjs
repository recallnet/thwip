/**
 * Interpret a checkout for the deploy gate.
 *
 * GitHub Actions checks out a commit with a detached HEAD. Treating every
 * detached checkout as main would remove the local branch guard. This accepts
 * only the one detached shape the staging workflow creates: the canonical
 * repository, the canonical main ref, the exact workflow SHA, and a freshly
 * fetched origin/main at that same SHA.
 */

const REPOSITORY = "recallnet/thwip";
const REPOSITORY_ID = "1315419165";
const MAIN_REF = "refs/heads/main";
const WORKFLOW_PREFIX = `${REPOSITORY}/.github/workflows/deploy-staging.yml@`;

const actionRefusal = (detail) => ({
  branch: "HEAD",
  note: null,
  refusal: `Refusing GitHub Actions deploy checkout: ${detail}`,
});

export function deployCheckout(facts, env) {
  if (env.GITHUB_ACTIONS !== "true") {
    return { branch: facts.gitBranch, note: null, refusal: null };
  }

  if (env.CI !== "true") return actionRefusal("CI is not true");
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REPOSITORY_ID !== REPOSITORY_ID) {
    return actionRefusal(`expected ${REPOSITORY} (${REPOSITORY_ID})`);
  }
  if (!["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME ?? "")) {
    return actionRefusal("only push and workflow_dispatch may deploy");
  }
  if (env.GITHUB_REF !== MAIN_REF) return actionRefusal(`expected ${MAIN_REF}`);
  if (env.GITHUB_WORKFLOW_REF !== `${WORKFLOW_PREFIX}${MAIN_REF}`) {
    return actionRefusal("the deploy workflow is not running from canonical main");
  }
  if (facts.dirty) return actionRefusal("the checkout has uncommitted changes");
  if (!/^[0-9a-f]{40,64}$/.test(env.GITHUB_SHA ?? "")) {
    return actionRefusal("GITHUB_SHA is not a full Git object id");
  }
  if (facts.headSha !== env.GITHUB_SHA) {
    return actionRefusal(`HEAD ${facts.headSha} does not match GITHUB_SHA`);
  }
  if (facts.remoteMainSha !== env.GITHUB_SHA) {
    return actionRefusal(`origin/main ${facts.remoteMainSha ?? "could not be read"} does not match GITHUB_SHA`);
  }

  return {
    branch: "main",
    note: `GitHub Actions checkout is canonical ${MAIN_REF} at ${facts.headSha}.`,
    refusal: null,
  };
}
