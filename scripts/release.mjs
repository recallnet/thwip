import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@recallnet/thwip";
const RELEASE_REPOSITORY = "recallnet/thwip";
const MAIN_REF = "refs/heads/main";
const RELEASE_WORKFLOW_REF = `${RELEASE_REPOSITORY}/.github/workflows/thwip-release.yml@${MAIN_REF}`;
export const CLI_EXTERNAL_PACKAGES = Object.freeze(["yaml"]);

/**
 * Every workspace package bundled into either the CLI or the GitHub Action.
 * A test derives this closure from package.json so a new workspace dependency
 * cannot quietly fall out of the release trigger again.
 */
export const RELEASE_PATHS = Object.freeze([
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "action.yml",
  "packages/action",
  "packages/cli",
  "packages/policy",
  "packages/prompts",
  "packages/protocol",
  "packages/queue-domain",
  "packages/queue-protocol",
  "packages/sshsig",
  "packages/verifier",
  "packages/vocabulary",
  "scripts/release.mjs",
]);

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (match === null) throw new Error(`expected a release version, received ${JSON.stringify(value)}`);
  return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function highestVersion(versions) {
  return versions.reduce((highest, version) =>
    compareVersions(version, highest) > 0 ? version : highest,
  "0.0.0");
}

export function bumpVersion(version, bump) {
  const [major, minor, patch] = parseVersion(version);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown release bump ${JSON.stringify(bump)}`);
}

/**
 * A changed release input always ships. Conventional Commit markers choose a
 * larger bump; plain-language merge titles safely default to a patch.
 */
export function releaseBump({ changed, subjects, bodies }) {
  if (!changed) return "none";
  if (/^[a-z]+(?:\(.+\))?!:/m.test(subjects) || /(?:^|\n)BREAKING CHANGE(?::|\n)/.test(bodies)) {
    return "major";
  }
  if (/^feat(?:\(.+\))?:/m.test(subjects)) return "minor";
  return "patch";
}

export function releaseSourceCommit(value) {
  if (typeof value.gitHead === "string") return value.gitHead;
  return typeof value.thwipSourceCommit === "string" ? value.thwipSourceCommit : null;
}

export function plannedVersion({
  bump,
  declaredVersion,
  lastTagVersion,
  npm,
  github,
  head,
}) {
  const registries = [
    ["npm", npm],
    ["GitHub Packages", github],
  ];
  if (
    npm.version !== "0.0.0" &&
    npm.version === github.version &&
    npm.sourceCommit !== github.sourceCommit
  ) {
    throw new Error(
      `${PACKAGE}@${npm.version} comes from different commits in npm and GitHub Packages; ` +
        "refusing to publish over an inconsistent mirror",
    );
  }
  const current = highestVersion([
    declaredVersion,
    lastTagVersion,
    ...registries.map(([, registry]) => registry.version),
  ]);
  const currentPublications = registries.filter(([, registry]) => registry.version === current);
  const partialAtHead =
    currentPublications.length > 0 &&
    currentPublications.every(([, registry]) => registry.sourceCommit === head);
  const recovering = compareVersions(current, lastTagVersion) > 0 && partialAtHead;
  const version = recovering ? current : bumpVersion(current, bump);

  for (const [label, registry] of registries) {
    if (registry.version === version && registry.sourceCommit !== head) {
      throw new Error(
        `${label} already contains ${PACKAGE}@${version} from ` +
          `${registry.sourceCommit ?? "an unknown commit"}; refusing to overwrite or tag it as ${head}`,
      );
    }
  }

  return {
    version,
    recovering,
    npmExists: npm.version === version,
    githubExists: github.version === version,
  };
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", ...options }).trim();
}

/** Refuse any Actions release that is not the exact clean canonical main tree. */
export function releaseCheckout(facts, env) {
  if (env.GITHUB_ACTIONS !== "true") return null;
  if (env.CI !== "true") return "CI is not true";
  if (!/^\d+$/.test(env.THWIP_RELEASE_REPOSITORY_ID ?? "")) {
    return "THWIP_RELEASE_REPOSITORY_ID is not configured";
  }
  if (
    env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY ||
    env.GITHUB_REPOSITORY_ID !== env.THWIP_RELEASE_REPOSITORY_ID
  ) {
    return `expected ${RELEASE_REPOSITORY} (${env.THWIP_RELEASE_REPOSITORY_ID})`;
  }
  if (!["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME ?? "")) return "only push and workflow_dispatch may release";
  if (env.GITHUB_REF !== MAIN_REF) return `expected ${MAIN_REF}`;
  if (env.GITHUB_WORKFLOW_REF !== RELEASE_WORKFLOW_REF) return "the release workflow is not running from canonical main";
  if (facts.dirty) return "the checkout has uncommitted changes";
  if (!/^[0-9a-f]{40,64}$/.test(env.GITHUB_SHA ?? "")) return "GITHUB_SHA is not a full Git object id";
  if (facts.headSha !== env.GITHUB_SHA) return `HEAD ${facts.headSha} does not match GITHUB_SHA`;
  if (facts.remoteMainSha !== env.GITHUB_SHA) return `origin/main ${facts.remoteMainSha} does not match GITHUB_SHA`;
  return null;
}

function requireCanonicalReleaseCheckout(env = process.env) {
  if (env.GITHUB_ACTIONS !== "true") return;
  try {
    git(["fetch", "--quiet", "origin", "main"]);
  } catch {
    throw new Error("Refusing release: canonical origin/main could not be fetched.");
  }
  const refusal = releaseCheckout({
    headSha: git(["rev-parse", "HEAD"]),
    remoteMainSha: git(["rev-parse", "origin/main"]),
    dirty: git(["status", "--porcelain"]).length > 0,
  }, env);
  if (refusal !== null) throw new Error(`Refusing release: ${refusal}.`);
}

function registryInfo({ registry, userconfig }) {
  const args = [
    "view",
    PACKAGE,
    "version",
    "gitHead",
    "thwipSourceCommit",
    "--json",
    `--registry=${registry}`,
  ];
  if (userconfig) args.push(`--userconfig=${userconfig}`);
  const result = spawnSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
  });
  if (result.status !== 0) {
    const failure = `${result.stdout}\n${result.stderr}`;
    if (/\bE404\b|\b404 Not Found\b/.test(failure)) {
      return { version: "0.0.0", sourceCommit: null };
    }
    throw new Error(`could not read ${PACKAGE} from ${registry}: ${failure.trim()}`);
  }
  const value = JSON.parse(result.stdout);
  return {
    version: typeof value.version === "string" ? value.version : "0.0.0",
    sourceCommit: releaseSourceCommit(value),
  };
}

function append(path, lines) {
  if (!path) return;
  appendFileSync(path, `${lines.join("\n")}\n`);
}

export function planRelease({
  npmjsUserconfig = process.env.NPMJS_NPMRC,
  githubUserconfig = process.env.GITHUB_NPMRC,
  head = process.env.GITHUB_SHA || git(["rev-parse", "HEAD"]),
} = {}) {
  requireCanonicalReleaseCheckout();
  let lastTag = "";
  try {
    lastTag = git(["describe", "--tags", "--abbrev=0", "--match", "v*"]);
  } catch {
    // The first release has no tag.
  }
  const lastTagVersion = lastTag ? lastTag.slice(1) : "0.0.0";
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const subjects = git(["log", "--format=%s", range, "--", ...RELEASE_PATHS]);
  const bodies = git(["log", "--format=%B", range, "--", ...RELEASE_PATHS]);
  const changed = subjects.length > 0;
  const bump = releaseBump({ changed, subjects, bodies });
  if (bump === "none") return { release: false, lastTag, bump };

  const declaredVersion = JSON.parse(
    readFileSync(join(root, "packages/cli/package.json"), "utf8"),
  ).version;
  const npm = registryInfo({
    registry: "https://registry.npmjs.org",
    userconfig: npmjsUserconfig,
  });
  const github = registryInfo({
    registry: "https://npm.pkg.github.com",
    userconfig: githubUserconfig,
  });
  return {
    release: true,
    lastTag,
    bump,
    head,
    npm,
    github,
    ...plannedVersion({ bump, declaredVersion, lastTagVersion, npm, github, head }),
  };
}

export function stampBuild(outDir = join(root, "packages/cli/dist")) {
  const output = resolve(outDir);
  const version =
    process.env.THWIP_RELEASE_VERSION ||
    JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
  writeFileSync(
    join(output, "build-stamp.json"),
    `${JSON.stringify({ version, commit: `${git(["rev-parse", "HEAD"])}${git(["status", "--porcelain"]) ? "-dirty" : ""}` }, null, 2)}\n`,
  );
}

export async function buildPackage() {
  // Planning runs before the workflow installs dependencies. Load the bundler
  // only for the package command, which runs after that install.
  const { build } = await import("esbuild");
  const out = join(root, "packages/cli/dist-npm");
  const version =
    process.env.THWIP_RELEASE_VERSION ||
    JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(root, "packages/cli/src/main.ts")],
    outfile: join(out, "thwip.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    external: CLI_EXTERNAL_PACKAGES,
  });
  chmodSync(join(out, "thwip.mjs"), 0o755);
  stampBuild(out);
  const stamp = JSON.parse(readFileSync(join(out, "build-stamp.json"), "utf8"));
  writeFileSync(
    join(out, "package.json"),
    `${JSON.stringify({
      name: PACKAGE,
      version,
      description: "Verified local CI. Run your suites where the code lives and sign a proof of the exact Git tree.",
      keywords: ["ci", "attestation", "provenance", "git", "github", "signing"],
      homepage: "https://thwip.ai",
      bugs: { url: "https://thwip.ai" },
      repository: { type: "git", url: "git+https://github.com/recallnet/thwip.git" },
      thwipSourceCommit: stamp.commit,
      license: "Apache-2.0",
      type: "module",
      bin: { thwip: "thwip.mjs" },
      files: ["thwip.mjs", "build-stamp.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
      engines: { node: ">=22" },
      dependencies: { yaml: "^2.9.0" },
      publishConfig: { access: "public" },
    }, null, 2)}\n`,
  );
  const readme = join(root, "packages/cli/README.md");
  if (!existsSync(readme)) throw new Error("packages/cli/README.md is required for the npm package");
  copyFileSync(readme, join(out, "README.md"));
  copyFileSync(join(root, "LICENSE"), join(out, "LICENSE"));
  copyFileSync(join(root, "THIRD_PARTY_NOTICES.md"), join(out, "THIRD_PARTY_NOTICES.md"));
  process.stdout.write(`built ${out} (thwip@${version})\n`);
}

function plan() {
  const plan = planRelease();
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  if (!plan.release) {
    append(process.env.GITHUB_OUTPUT, ["release=false"]);
    append(process.env.GITHUB_STEP_SUMMARY, [
      `Nothing in the published CLI or Action changed since ${plan.lastTag || "the beginning"}.`,
    ]);
    return;
  }
  append(process.env.GITHUB_OUTPUT, [
    "release=true",
    `version=${plan.version}`,
    `npm_exists=${plan.npmExists}`,
    `github_exists=${plan.githubExists}`,
  ]);
  append(process.env.GITHUB_STEP_SUMMARY, [
    `${plan.bump}: ${plan.lastTag || "no tag"} to v${plan.version}`,
    plan.recovering ? "Recovered a partial publication at this exact commit." : "Planned a new release.",
  ]);
}

async function main() {
  const [command, value] = process.argv.slice(2);
  if (command === "plan") return plan();
  if (command === "package") return buildPackage();
  if (command === "stamp") return stampBuild(value);
  throw new Error("usage: release.mjs plan|package|stamp [output-directory]");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
