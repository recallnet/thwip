/**
 * Find exported values nothing imports.
 *
 * Code written, tested, and called by nothing is the single largest bug family
 * this repository has produced. `signLocalRunAssignment` and
 * `acceptIntegrationReceipt` sat uncalled while the `fresh` profile enforced
 * nothing. `BOOTSTRAP_STEPS` and `mayActivate` sat uncalled while enrolling a
 * repository meant hand-writing rows. `buildCheck` sat uncalled while
 * `policyRuleset()` pinned its check as required, so a repository provisioned
 * from it would have blocked forever on a check nobody publishes. `runTurn` sat
 * uncalled while writing merge commits with no attribution trailer, which would
 * have made the queue's own merges read back as external pushes. Each was found
 * by accident, months apart, and each cost production time.
 *
 * A reviewer cannot see this. The function is there, it is documented, it has
 * tests, and the tests pass. The only thing missing is an import, and no diff
 * shows an import that was never written. So it is checked.
 *
 * What the check tolerates matters more than what it catches, because a check
 * that cries wolf gets switched off:
 *
 *   - Entry points, read from the configuration that names them: the Worker's
 *     `main` in wrangler.jsonc, the bundler entries, the web app's script tag,
 *     a source file a package script hands to a tool by path. Nothing in this
 *     repository imports them, and nothing should.
 *   - Types and interfaces. A type used structurally is used without being
 *     imported, so a name-based check cannot tell. Values only.
 *   - Test files. A helper shared between two suites is real use.
 *
 * There are no named allowances. There were fifty-five, most reading "unwired",
 * and four of them were this check's own defect rather than dead code. An
 * allowlist is where a check like this goes to die: the entry costs one line,
 * the reason is written once and never reread, and the list outgrows the
 * findings it was meant to shrink. What is tolerated is written into the rules
 * above instead, where it has to stay true.
 *
 * Re-exports are followed rather than counted. `export * from "./x.js"` in a
 * package index makes a name reachable under `@thwip/pkg`; it is not itself a
 * use of that name. Counting it as one would blind the check to whole packages,
 * which is the failure mode of every "unused export" tool that treats a barrel
 * file as a consumer.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/** Sources the check reads. Everything tracked, nothing built. */
export function sourceFiles(root) {
  return execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f.length > 0 && !f.includes("/dist/") && !f.includes("node_modules/"));
}

/**
 * Modules nothing may be expected to import, read from what names them.
 *
 * Hard-coding this list is how it goes stale: a new Durable Object or a second
 * bundle entry would be reported as dead the day it is added, and whoever hit
 * that would reach for the allowlist. So each one is read out of the file that
 * already declares it.
 */
export function entryPoints(root) {
  const found = new Set();
  const add = (p) => {
    const rel = p.startsWith("/") ? relative(root, p) : p;
    if (existsSync(join(root, rel))) found.add(rel);
  };

  // The Worker. wrangler.jsonc is JSONC, and the one field wanted is a string.
  const wrangler = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const main = /"main"\s*:\s*"([^"]+)"/.exec(wrangler);
  if (main !== null) add(main[1]);

  // Bundler entries. Written as `entryPoints: [join(root, "…")]` in the build
  // scripts and as an esbuild argument in the Action's package script.
  for (const file of ["scripts/build-npm.mjs"]) {
    const text = readFileSync(join(root, file), "utf8");
    for (const m of text.matchAll(/join\(root,\s*"([^"]+\.tsx?)"\)/g)) add(m[1]);
  }
  for (const pkg of execFileSync("git", ["ls-files", "*/package.json"], { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f.length > 0 && !f.includes("node_modules/"))) {
    const json = JSON.parse(readFileSync(join(root, pkg), "utf8"));
    const scripts = json.scripts ?? {};
    for (const command of Object.values(scripts)) {
      for (const m of String(command).matchAll(/esbuild\s+(\S+\.tsx?)/g)) add(join(dirname(pkg), m[1]));
      // A tool handed a source file by path. `@better-auth/cli generate` reads
      // `src/auth.cli.ts` this way to emit the auth schema: it never imports
      // through the app's module graph, so no call site can exist and both the
      // file and the devDependency read as dead. The package script is what
      // names the relationship, so it is what this reads.
      for (const m of String(command).matchAll(/--config\s+(\S+\.tsx?)/g)) add(join(dirname(pkg), m[1]));
    }
  }

  // The web app, from the script tag that loads it.
  for (const html of execFileSync("git", ["ls-files", "*.html"], { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f.length > 0 && !f.includes("node_modules/"))) {
    const text = readFileSync(join(root, html), "utf8");
    for (const m of text.matchAll(/src="\.?\/?([^"]+\.tsx?)"/g)) add(join(dirname(html), m[1]));
  }

  // Astro content collections and file-based routes. Nothing imports these
  // modules; Astro loads them by path from the package root, the same way
  // wrangler names the Worker main. A pages/*.ts export of GET or
  // getStaticPaths is the route entry, not dead code.
  for (const f of execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f.length > 0 && !f.includes("node_modules/"))) {
    if (/^apps\/[^/]+\/src\/content\.config\.ts$/.test(f)) add(f);
    if (/^apps\/[^/]+\/src\/pages\/.+\.tsx?$/.test(f)) add(f);
  }

  return found;
}

function parse(root, file) {
  return ts.createSourceFile(
    file,
    readFileSync(join(root, file), "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Where a specifier points, or null when it leaves the repository. */
function resolveSpecifier(root, fromFile, specifier) {
  let base;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(join(root, fromFile)), specifier);
  } else if (specifier.startsWith("@thwip/")) {
    base = join(root, "packages", specifier.slice("@thwip/".length), "src", "index");
  } else {
    return null;
  }
  const stripped = base.replace(/\.js$/, "").replace(/\.jsx$/, "");
  for (const candidate of [
    `${stripped}.ts`,
    `${stripped}.tsx`,
    join(stripped, "index.ts"),
    join(stripped, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return relative(root, candidate);
  }
  return null;
}

const hasExport = (node) =>
  ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;

/**
 * What a module declares and what it re-exports, kept apart.
 *
 * `local` is a name this file defines and exports: a candidate for being dead.
 * `forwarded` is a name it merely passes along, which is plumbing, and `stars`
 * are the modules it passes along wholesale.
 */
function readModule(root, file) {
  const source = parse(root, file);
  const local = new Map();
  const forwarded = new Map();
  const stars = [];
  const imports = [];

  const declarationNames = new Set();
  const record = (nameNode, node, isType) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    declarationNames.add(nameNode);
    local.set(nameNode.text, { file, name: nameNode.text, line: line + 1, isType });
  };

  /**
   * Names this file mentions somewhere other than the declaration itself.
   *
   * A function its own module calls is not dead, whatever the export keyword
   * suggests. Reporting those would bury the four cases this exists for under a
   * hundred and forty notes about a keyword, and the check would be switched off
   * inside a week. Unexporting them is a tidy-up; this is a bug detector.
   */
  /**
   * A name written where a property goes, which is not a use of anything.
   *
   * `liveGuardDigest` is a function in `evidence.ts` and also a field name in an
   * interface twenty lines above it. Counting the field as a mention made the
   * function look self-used, so the only implementation of the final live guard
   * sat called by nothing but its own test and this check said nothing. The
   * shorthand form stays a use, because `{ liveGuardDigest }` really does read
   * the binding.
   */
  const isPropertyName = (node) => {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
    if (ts.isQualifiedName(parent)) return parent.right === node;
    return (
      (ts.isPropertySignature(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isEnumMember(parent) ||
        ts.isBindingElement(parent)) &&
      parent.name === node
    );
  };

  const mentioned = new Set();
  const walk = (node) => {
    if (
      ts.isIdentifier(node) &&
      !declarationNames.has(node) &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isExportSpecifier(node.parent) &&
      !isPropertyName(node)
    ) {
      mentioned.add(node.text);
    }

    // `await import("./x.js")`, which is an expression rather than a statement.
    //
    // Reading only top-level import declarations reported the whole Dagger runner
    // as dead: `main.ts` lazy-loads it so that repositories using the command
    // runner never pay for the download-and-spawn module. Three live functions
    // were sitting in the allowlist under the reason "dagger runner, unwired",
    // where they would have hidden a genuine regression in that path.
    //
    // The module counts as wholly reached rather than picking names out of the
    // destructuring pattern. A check whose failure mode is crying wolf should
    // over-count reach, not under-count it.
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push({ specifier: node.arguments[0].text, all: true });
    }

    ts.forEachChild(node, walk);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause === undefined) continue;
      if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
        imports.push({ specifier, all: true });
        continue;
      }
      if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          imports.push({ specifier, name: (element.propertyName ?? element.name).text });
        }
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier?.text;
      if (statement.exportClause === undefined) {
        if (specifier !== undefined) stars.push(specifier);
        continue;
      }
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const origin = (element.propertyName ?? element.name).text;
          if (specifier === undefined) {
            // `export { local }` on a name this file defines. The declaration
            // itself carried no export modifier, so record it here.
            record(element.name, element, statement.isTypeOnly);
          } else {
            forwarded.set(element.name.text, { specifier, name: origin });
          }
        }
      }
      continue;
    }

    if (!hasExport(statement)) continue;

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) record(statement.name, statement, false);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) record(declaration.name, declaration, false);
      }
    } else if (ts.isEnumDeclaration(statement)) {
      record(statement.name, statement, false);
    } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      record(statement.name, statement, true);
    }
  }

  walk(source);
  return { local, forwarded, stars, imports, mentioned };
}

/**
 * Follow a name to where it is defined, through however many barrels forward it.
 * The cycle guard matters: package indexes re-export each other's shapes.
 */
function originOf(root, modules, file, name, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const module = modules.get(file);
  if (module === undefined) return null;
  if (module.local.has(name)) return { file, name };
  const forward = module.forwarded.get(name);
  if (forward !== undefined) {
    const target = resolveSpecifier(root, file, forward.specifier);
    return target === null ? null : originOf(root, modules, target, forward.name, seen);
  }
  for (const star of module.stars) {
    const target = resolveSpecifier(root, file, star);
    if (target === null) continue;
    const found = originOf(root, modules, target, name, seen);
    if (found !== null) return found;
  }
  return null;
}

function everythingIn(root, modules, file, reached, seen = new Set()) {
  if (seen.has(file)) return;
  seen.add(file);
  const module = modules.get(file);
  if (module === undefined) return;
  for (const name of module.local.keys()) reached.add(`${file}#${name}`);
  for (const forward of module.forwarded.values()) {
    const target = resolveSpecifier(root, file, forward.specifier);
    if (target === null) continue;
    const origin = originOf(root, modules, target, forward.name);
    if (origin !== null) reached.add(`${origin.file}#${origin.name}`);
  }
  for (const star of module.stars) {
    const target = resolveSpecifier(root, file, star);
    if (target !== null) everythingIn(root, modules, target, reached, seen);
  }
}

/**
 * Test code, for both purposes this check has for the word.
 *
 * A suite is not a caller. `finalGuard`, `decideMergeWrite` and
 * `classifyMergeResponse` each had a thorough test and no production import, and
 * counting the suite as use is what let all four of the earlier cases pass
 * review. So reach is counted from shipping files only.
 *
 * The same names are also not reported: a helper two suites share is real use,
 * and a fixture module under `test/` exists for them.
 */
const isTest = (file) => /\.test\.tsx?$/.test(file) || /(^|\/)test\//.test(file);

/**
 * Exported values nothing imports.
 *
 * Returned rather than thrown, and sorted, so the caller can print the whole
 * list at once. Being told about one dead export at a time is how a reviewer
 * ends up deleting a pile of them across a dozen runs.
 */
export function uncalledExports({ root, files = sourceFiles(root), entries = entryPoints(root) }) {
  const modules = new Map();
  for (const file of files) modules.set(file, readModule(root, file));

  const reached = new Set();
  for (const [file, module] of modules) {
    if (isTest(file)) continue;
    for (const use of module.imports) {
      const target = resolveSpecifier(root, file, use.specifier);
      if (target === null) continue;
      if (use.all === true) {
        everythingIn(root, modules, target, reached);
        continue;
      }
      const origin = originOf(root, modules, target, use.name);
      if (origin !== null) reached.add(`${origin.file}#${origin.name}`);
    }
  }

  const dead = [];
  for (const [file, module] of modules) {
    if (entries.has(file) || isTest(file)) continue;
    for (const declared of module.local.values()) {
      if (declared.isType) continue;
      if (reached.has(`${file}#${declared.name}`)) continue;
      if (module.mentioned.has(declared.name)) continue;
      dead.push(declared);
    }
  }
  dead.sort((a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file)));
  return dead;
}

/** One line per finding, in the form a reader can jump to. */
export function describe(dead) {
  return dead.map((d) => `${d.file}:${d.line} ${d.name}`);
}
