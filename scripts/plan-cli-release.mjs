import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@recallnet/thwip";

/**
 * Every workspace package bundled into either the CLI or the GitHub Action.
 * A test derives this closure from package.json so a new workspace dependency
 * cannot quietly fall out of the release trigger again.
 */
export const RELEASE_PATHS = Object.freeze([
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
  "scripts/build-npm.mjs",
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

export function plannedVersion({
  bump,
  declaredVersion,
  lastTagVersion,
  npm,
  github,
  head,
}) {
  const current = highestVersion([declaredVersion, lastTagVersion, npm.version, github.version]);
  const partialAtHead = [npm, github].some(
    (registry) => registry.version === current && registry.sourceCommit === head,
  );
  const recovering = compareVersions(current, lastTagVersion) > 0 && partialAtHead;
  const version = recovering ? current : bumpVersion(current, bump);

  for (const [name, registry] of [["npm", npm], ["GitHub Packages", github]]) {
    if (registry.version === version && registry.sourceCommit !== head) {
      throw new Error(
        `${name} already contains ${PACKAGE}@${version} from ${registry.sourceCommit ?? "an unknown commit"}; ` +
          `refusing to overwrite or tag it as ${head}`,
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
    sourceCommit:
      typeof value.thwipSourceCommit === "string"
        ? value.thwipSourceCommit
        : typeof value.gitHead === "string"
          ? value.gitHead
          : null,
  };
}

function append(path, lines) {
  if (!path) return;
  appendFileSync(path, `${lines.join("\n")}\n`);
}

export function planRelease({
  npmjsUserconfig = process.env.NPMJS_NPMRC,
  githubPackagesUserconfig = process.env.GITHUB_PACKAGES_NPMRC,
  head = process.env.GITHUB_SHA || git(["rev-parse", "HEAD"]),
} = {}) {
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
    userconfig: githubPackagesUserconfig,
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

function main() {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
