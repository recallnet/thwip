/**
 * Build the publishable `thwip` package.
 *
 * The CLI depends on six workspace packages, and `workspace:*` means nothing to
 * npm. Publishing all seven would put six packages nobody installs directly into a
 * public namespace, and every release would have to keep their versions in step.
 * Bundling instead ships one artifact with no dependencies, which is also what
 * makes `npx thwip` a single download.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/cli/dist-npm");
// The release passes the version it computed rather than writing it into the
// checkout first. Rewriting the file left uncommitted changes behind, so every
// published build stamped itself `<sha>-dirty` and `thwip version` on a clean
// npm install said what a local hack says.
const version =
  process.env.THWIP_RELEASE_VERSION ||
  JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// esbuild's API rather than its binary. Spawning the binary meant guessing where
// a package manager had put it, and the guess only held on the machine where it
// was written: a clean install put it somewhere else and the release failed.
await build({
  entryPoints: [join(root, "packages/cli/src/main.ts")],
  outfile: join(out, "thwip.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Node builtins stay external; everything else, workspace or not, is inlined.
  // No shebang banner: src/main.ts already starts with one and esbuild keeps it,
  // so adding another puts a second on line 2, where it is a syntax error.
  packages: "bundle",
  // yaml stays a real dependency. Its published entry is CommonJS, and inlining
  // that into an ESM bundle produces a dynamic require Node refuses to perform.
  external: ["yaml"],
});
chmodSync(join(out, "thwip.mjs"), 0o755);

// The bundle reads this beside itself to answer `thwip version`.
execFileSync("node", [join(root, "scripts/stamp-build.mjs"), out], { stdio: "inherit" });

writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "@recallnet/thwip",
      version,
      description: "Verified local CI. Run your suites where the code lives and sign a proof of the exact Git tree.",
      keywords: ["ci", "attestation", "provenance", "git", "github", "signing"],
      homepage: "https://recall.network",
      bugs: { url: "https://recall.network" },
      license: "Apache-2.0",
      type: "module",
      bin: { thwip: "thwip.mjs" },
      // The build stamp ships too. It is how an installed thwip answers
      // `thwip version` with the commit it was built from instead of a shrug.
      files: ["thwip.mjs", "build-stamp.json", "README.md"],
      engines: { node: ">=22" },
      dependencies: { yaml: "^2.9.0" },
      publishConfig: { access: "public" },
    },
    null,
    2,
  )}\n`,
);

// The package README must be written for someone who has just installed the
// CLI. Falling back to the repository's README once published an internal
// engineering document to npm, naming the staging control plane, the design
// documents, and how internal pull requests merge. A missing README is a build failure now,
// because the quiet fallback is worse than stopping.
const readme = join(root, "packages/cli/README.md");
if (!existsSync(readme)) {
  throw new Error(
    "packages/cli/README.md is missing. It is what npm renders on the package page; " +
      "the repository README is an internal document and must never be published.",
  );
}
copyFileSync(readme, join(out, "README.md"));

process.stdout.write(`built ${out} (thwip@${version})\n`);
