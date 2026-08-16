import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import ts from "typescript";
import { claudePointer, queueInstructions } from "../packages/prompts/src/queue.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const workflowFiles = readdirSync(join(root, ".github/workflows"))
  .filter((name) => name.endsWith(".yml"));

function managed(text) {
  const match = /<!-- thwip:start -->\n([\s\S]*?)<!-- thwip:end -->/.exec(text);
  return match?.[1] ?? null;
}

describe("canonical repository agent contract", () => {
  it("is already the exact output init would write", () => {
    expect(managed(read("AGENTS.md"))).toBe(queueInstructions({ cliCommand: "pnpm -w thwip" }));
    expect(managed(read("CLAUDE.md"))).toBe(claudePointer() + "\n");
  });
});

const UNKNOWN_WRITE = Symbol("unknown write");

function nodeName(node) {
  if (node === undefined) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

function ownedShape(container) {
  if (ts.isInterfaceDeclaration(container)) return true;
  for (let node = container.parent; node !== undefined; node = node.parent) {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return false;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) return false;
    if (ts.isSourceFile(node)) return true;
  }
  return true;
}

function literalValue(node) {
  let value = node;
  while (
    ts.isParenthesizedExpression(value)
    || ts.isAsExpression(value)
    || (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(value))
  ) value = value.expression;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return JSON.stringify(value.text);
  if (ts.isNumericLiteral(value)) return value.text;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (value.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (value.kind === ts.SyntaxKind.NullKeyword) return "null";
  return UNKNOWN_WRITE;
}

function truthiness(value) {
  if (value === "true") return true;
  if (value === "false" || value === "null") return false;
  return null;
}

function truthPosition(node) {
  let current = node;
  let negated = false;
  for (;;) {
    const parent = current.parent;
    if (parent === undefined) return negated;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)) {
      current = parent;
      continue;
    }
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
      negated = true;
      current = parent;
      continue;
    }
    if (
      ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent))
        && parent.expression === current)
      || (ts.isConditionalExpression(parent) && parent.condition === current)
      || (ts.isForStatement(parent) && parent.condition === current)
      || (ts.isBinaryExpression(parent)
        && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind))
    ) return true;
    return negated;
  }
}

/** A small production-only guard for constant fields that make refusal branches dead. */
function constantFieldFindings(inputs) {
  const declarations = new Map();
  const writes = new Map();
  const comparisons = [];
  const truthReads = [];
  const reads = new Map();
  const literals = [];
  const assertedTypes = new Set();
  const production = inputs.filter(({ path }) => !/\.test\.[cm]?[jt]sx?$/.test(path) && !/(^|\/)test\//.test(path));
  const addWrite = (name, value) => {
    if (name === null) return;
    const values = writes.get(name) ?? new Set();
    values.add(value);
    writes.set(name, values);
  };
  for (const { path, source } of production) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
        const name = nodeName(node.name);
        if (name !== null) {
          const container = node.parent;
          const isShape = ts.isPropertySignature(node)
            && (ts.isInterfaceDeclaration(container) || ts.isTypeLiteralNode(container))
            && ownedShape(container);
          const members = isShape ? [...container.members] : [];
          declarations.set(name, [
            ...(declarations.get(name) ?? []),
            {
              optional: node.questionToken !== undefined,
              literalType: node.type !== undefined && ts.isLiteralTypeNode(node.type),
              isShape,
              container: ts.isInterfaceDeclaration(container) ? container.name.text : null,
              all: new Set(members.map((member) => nodeName(member.name)).filter((member) => member !== null)),
              required: members
                .filter((member) => ts.isPropertySignature(member) && member.questionToken === undefined)
                .map((member) => nodeName(member.name))
                .filter((member) => member !== null),
            },
          ]);
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        const written = new Set();
        let spread = false;
        for (const property of node.properties) {
          if (ts.isSpreadAssignment(property)) {
            spread = true;
            continue;
          }
          const name = nodeName(property.name);
          if (name !== null) written.add(name);
        }
        literals.push({ written, spread });
      }
      if (ts.isPropertyAssignment(node)) addWrite(nodeName(node.name), literalValue(node.initializer));
      if (ts.isShorthandPropertyAssignment(node)) addWrite(node.name.text, UNKNOWN_WRITE);
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) addWrite(propertyName(node.left), literalValue(node.right));
      if (ts.isBinaryExpression(node)) {
        const operators = new Map([
          [ts.SyntaxKind.EqualsEqualsToken, "equal"],
          [ts.SyntaxKind.EqualsEqualsEqualsToken, "equal"],
          [ts.SyntaxKind.ExclamationEqualsToken, "not-equal"],
          [ts.SyntaxKind.ExclamationEqualsEqualsToken, "not-equal"],
        ]);
        const operator = operators.get(node.operatorToken.kind);
        if (operator !== undefined) {
          const left = ts.isPropertyAccessExpression(node.left) ? propertyName(node.left) : null;
          const right = ts.isPropertyAccessExpression(node.right) ? propertyName(node.right) : null;
          if (left !== null) comparisons.push({ name: left, operator, value: literalValue(node.right), path });
          if (right !== null) comparisons.push({ name: right, operator, value: literalValue(node.left), path });
        }
      }
      if (ts.isCaseClause(node) && ts.isSwitchStatement(node.parent.parent)) {
        const name = propertyName(node.parent.parent.expression);
        if (name !== null) comparisons.push({ name, operator: "equal", value: literalValue(node.expression), path });
      }
      if (ts.isPropertyAccessExpression(node)) {
        const assigned = ts.isBinaryExpression(node.parent)
          && node.parent.left === node
          && node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        if (!assigned) reads.set(node.name.text, (reads.get(node.name.text) ?? 0) + 1);
      }
      if (ts.isPropertyAccessExpression(node) && truthPosition(node)) {
        const name = propertyName(node);
        if (name !== null) truthReads.push({ name, path });
      }
      if (ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type)) {
        assertedTypes.add(node.type.typeName.getText(file));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const usableWrites = (name) => {
    const declared = declarations.get(name) ?? [];
    const values = writes.get(name);
    return declared.length === 1 && !declared[0].optional && !declared[0].literalType && values?.size > 0 && !values.has(UNKNOWN_WRITE)
      ? values
      : null;
  };
  const findings = [];
  for (const [name, declared] of declarations) {
    if (declared.length !== 1 || writes.has(name) || (reads.get(name) ?? 0) === 0) continue;
    const [shape] = declared;
    if (!shape.isShape || shape.optional || shape.literalType || assertedTypes.has(shape.container)) continue;
    const others = shape.required.filter((member) => member !== name);
    const builder = literals.some(({ written, spread }) => {
      if (spread || written.size === 0 || others.length < 3) return false;
      if ([...written].some((member) => !shape.all.has(member))) return false;
      return others.filter((member) => written.has(member)).length / others.length >= 0.6;
    });
    if (builder) findings.push(`${name}: production builds and reads this required field but never writes it`);
  }
  for (const { name, operator, value, path } of comparisons) {
    const values = usableWrites(name);
    if (values === null || value === UNKNOWN_WRITE) continue;
    if (
      (operator === "equal" && !values.has(value))
      || (operator === "not-equal" && (values.size === 1 || !values.has(value)))
    ) {
      findings.push(`${path}: ${name} compares against a value production never writes`);
    }
  }
  for (const { name, path } of truthReads) {
    const values = usableWrites(name);
    if (values === null) continue;
    const outcomes = new Set([...values].map(truthiness));
    if (!outcomes.has(null) && outcomes.size === 1) findings.push(`${path}: ${name} never changes truth value in production`);
  }
  return [...new Set(findings)].sort();
}

function criticalProductionSources() {
  const directories = [
    "apps/control-plane/src",
    "packages/policy/src",
    "packages/queue-domain/src",
    "packages/queue-protocol/src",
    "packages/verifier/src",
  ];
  return directories.flatMap((directory) => readdirSync(join(root, directory), { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => ({ path: `${directory}/${name}`, source: read(`${directory}/${name}`) })));
}

describe("repository automation", () => {
  it("keeps tests from hiding production fields whose refusal branch is dead", () => {
    const fixture = constantFieldFindings([
      {
        path: "facts.ts",
        source: 'interface Facts { readonly checks: "passing" | "failing"; }\n'
          + 'export const facts: Facts = { checks: "passing" };\n'
          + 'export const blocked = facts.checks === "failing";\n',
      },
      {
        path: "facts.test.ts",
        source: 'import { facts } from "./facts.js";\nvoid { ...facts, checks: "failing" };\n',
      },
    ]);
    expect(fixture).toEqual(["facts.ts: checks compares against a value production never writes"]);
    expect(constantFieldFindings([{
      path: "missing.ts",
      source: "interface Facts { proof: string; policy: string; head: string; ready: boolean; }\n"
        + 'const facts: Facts = { policy: "p", head: "h", ready: true };\n'
        + 'export const missing = facts.proof === "verified";\n',
    }])).toEqual(["proof: production builds and reads this required field but never writes it"]);
    expect(constantFieldFindings([{
      path: "inequality.ts",
      source: "interface Facts { checks: string; }\n"
        + 'const facts: Facts = { checks: "passing" };\n'
        + 'export const allowed = facts.checks !== "failing";\n',
    }])).toEqual(["inequality.ts: checks compares against a value production never writes"]);
    expect(constantFieldFindings(criticalProductionSources())).toEqual([]);
  });

  it("parses every workflow and pins every third-party action", () => {
    for (const name of workflowFiles) {
      const workflow = parse(read(`.github/workflows/${name}`));
      expect(workflow.jobs, name).toBeTypeOf("object");
      expect(workflow, name).toHaveProperty("on");
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          if (typeof step.uses !== "string" || step.uses === "./") continue;
          expect(step.uses, name).toMatch(/^[^@]+@[0-9a-f]{40}$/);
        }
      }
    }
  });

  it("keeps Node built-ins out of the Worker bundle", () => {
    const directory = join(root, "apps/control-plane/src");
    for (const name of readdirSync(directory, { recursive: true })) {
      if (typeof name !== "string" || !name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      expect(read(`apps/control-plane/src/${name}`), name).not.toMatch(/from ["']node:/);
    }
  });

  it("does not let a scheduled workflow rerun failed jobs", () => {
    for (const name of workflowFiles) {
      const source = read(`.github/workflows/${name}`);
      const workflow = parse(source);
      if (workflow.on?.schedule !== undefined) expect(source).not.toContain("rerun-failed-jobs");
    }
  });
});

describe("the staging deploy workflow", () => {
  const source = read(".github/workflows/deploy-staging.yml");
  const workflow = parse(source);
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

  it("uses canonical main, read-only GitHub authority, and one deployment lane", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.workflow_dispatch.inputs.deploy).toMatchObject({ type: "boolean", default: false });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "thwip-staging-deploy", "cancel-in-progress": false });
    for (const checkout of steps.filter((step) => step.uses?.startsWith("actions/checkout@"))) {
      expect(checkout.with).toMatchObject({ ref: "${{ github.sha }}", "fetch-depth": 0 });
    }
    expect(source).toContain('test "$canonical" = "$EXPECTED_SHA"');
  });

  it("verifies the exact SHA before both rehearsal and deploy", () => {
    expect(source.match(/pnpm thwip verify-chain/g)).toHaveLength(2);
    expect(source.match(/--expected-sha "\$\{\{ github\.sha \}\}"/g)).toHaveLength(2);
    expect(workflow.jobs.deploy.if).toContain("vars.THWIP_STAGING_DEPLOY_ENABLED == 'true'");
    expect(workflow.jobs.deploy.environment.name).toBe("staging");
  });

  it("hands build, gate, deploy, and confirmation to one command with no database write", () => {
    const deploy = workflow.jobs.deploy.steps.find((step) => step.id === "deploy");
    expect(deploy.run).toBe("pnpm --filter @thwip/control-plane run deploy:staging");
    expect(json("apps/control-plane/package.json").scripts["deploy:staging"])
      .toBe("node ../../scripts/control-plane.mjs deploy --env staging");
    const core = read("scripts/control-plane-core.mjs");
    expect(core).toContain('"--filter", "@thwip/control-plane", "exec", "wrangler"');
    expect(core).toContain('"--var", `BUILD_SHA:${sha}`');
    expect(core).toContain('"--var", `DEPLOYMENT_ID:${id}`');
    expect(core.indexOf('execFileSync(\n    "pnpm"')).toBeLessThan(core.lastIndexOf("waitForBuildSha({"));
    expect(source).not.toMatch(/wrangler\s+d1|migrations?\s+apply|migrate:staging/i);
  });
});

describe("workspace build order", () => {
  it("builds the application once, then writes the blog directly into its client output", () => {
    const rootPackage = json("package.json");
    const [bulk, blog] = rootPackage.scripts.build.split("&&").map((part) => part.trim());
    expect(bulk).toContain("!@thwip/blog");
    expect(blog).toBe("pnpm --filter @thwip/blog run build");
    expect(rootPackage.scripts.thwip).toBe("node packages/cli/dist/main.js");
    expect(rootPackage.dependencies?.["@thwip/cli"]).toBeUndefined();
    expect(json("apps/control-plane/package.json").scripts.build).not.toContain("@thwip/blog");
    const config = read("apps/blog/astro.config.mjs");
    expect(config).toContain('outDir: "../control-plane/dist/client"');
    expect(config).toContain("vite: { build: { emptyOutDir: false } }");
    expect(config).toContain('for (const path of ["blog", "_astro", "rss.xml", "sitemap-index.xml", "sitemap-0.xml"])');
    const vite = read("apps/control-plane/web/vite.config.ts");
    expect(vite).toContain('fileName: "install.md"');
    expect(vite).toContain("initPrompt()");
  });
});

describe("independent control-plane configuration", () => {
  const path = "wrangler.self-host.example.jsonc";
  const source = read(path);
  const config = json(path);

  it("starts fresh databases from the public baseline without hosted identifiers", () => {
    expect(config.d1_databases).toHaveLength(1);
    expect(config.d1_databases[0].migrations_dir).toBe("migrations-baseline");
    expect(config.vars.BILLING_MODE).toBe("disabled");
    expect(config.vars.STRIPE_PRICE_MONTHLY).toBeUndefined();
    expect(config.vars.STRIPE_PRICE_ANNUAL).toBeUndefined();
    expect(source).not.toMatch(/recallnet|thwip\.ai|thwip-staging|647114a5|price_[A-Za-z0-9]+/i);
    expect(read("wrangler.jsonc")).toContain('"BILLING_MODE": "stripe"');
  });

  it("declares every Worker storage and queue binding", () => {
    expect(config.durable_objects.bindings).toContainEqual({ name: "BRANCH_QUEUE", class_name: "BranchQueue" });
    expect(config.r2_buckets[0].binding).toBe("EVIDENCE");
    expect(config.queues.producers[0].binding).toBe("SYNC_QUEUE");
    expect(config.assets.binding).toBe("ASSETS");
  });
});
