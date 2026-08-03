/**
 * Find fields shipping code reads and never writes, and the comparisons that
 * can therefore never be true.
 *
 * This is one level below `uncalled-exports.mjs`, which finds functions nothing
 * calls. Here the function is called, the branch is written, and the field it
 * inspects was never populated, so the branch takes its default forever. The
 * repository calls this "absence is a pass" and has paid for it four times.
 * `ReadinessFacts.nonThwipChecks` is written in exactly one place, the
 * `NO_OBJECTION` default, and that place says `"passing"`, so the two branches
 * that push `REQUIRED_CHECK_FAILED` and `REQUIRED_CHECK_PENDING` cannot fire and
 * a failing required check reads as passing at the merge gate.
 * `proofPolicyDigest` is null everywhere it is set, so `POLICY_CHANGED` is
 * permanently false. `buildCheck` produced the same shape from the other side:
 * a required check nobody published.
 *
 * A reviewer cannot see any of this. The field is declared, the branch is
 * written, and the tests pass, because a test builds the object by hand and
 * writes the value production never writes.
 *
 * Two rules:
 *
 *   1. A declared property no shipping code writes, where shipping code reads it.
 *   2. A comparison against a literal no shipping code ever writes.
 *
 * What it tolerates matters more than what it catches, because a check that
 * cries wolf gets switched off. There is no type checker here, so the only thing
 * tying a read of `x.status` to a declaration of `status` is the name. Property
 * names repeat across unrelated types, so a name declared more than once
 * anywhere in the repository is dropped whole. That is cheap and conservative,
 * and it costs real coverage: `activePolicyDigest` is declared three times and
 * so is invisible to this check. Loosening the rule to recover it would conflate
 * every `status` and `id` in the tree, which is the failure mode that gets a
 * check deleted.
 *
 * The other tolerances:
 *
 *   - Test files, as writer, reader and comparer. A suite that sets the field is
 *     what hid all four earlier cases.
 *   - Optional properties under rule 1. One that is sometimes absent is normal.
 *   - Shapes this repository describes but does not build: a GitHub response, a
 *     D1 row. Rule 1 fires only when some object literal in shipping code builds
 *     most of the declaring type and leaves the field out. A type only ever
 *     spread from somewhere else, or cast from JSON, never produces such a
 *     literal, so it is never reported.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { sourceFiles } from "./uncalled-exports.mjs";

export { sourceFiles };

/**
 * Test code, for every purpose this check has for the word.
 *
 * Same shape as `uncalled-exports.mjs`. A suite writing the field is not the
 * shipping code writing the field; it is the thing that made the bug look fine.
 */
const isTest = (file) => /\.test\.tsx?$/.test(file) || /(^|\/)test\//.test(file);

function parse(root, file) {
  return ts.createSourceFile(
    file,
    readFileSync(join(root, file), "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const lineOf = (source, node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/**
 * Whether a shape is one this repository owns and builds.
 *
 * A type literal written inside `(await req.json()) as { … }` or as the type
 * argument to `githubJson<{ … }>()` describes something that arrived from
 * elsewhere: a request body, a GitHub response, a D1 row. Nothing here writes
 * those fields, and nothing should, so both rules would report every one of
 * them. The first run reported two, `canonicalJson` off an admin request body
 * and `encoding` off the GitHub blob response, and neither is a bug.
 */
function ownedShape(container) {
  if (ts.isInterfaceDeclaration(container)) return true;
  for (let node = container.parent; node !== undefined; node = node.parent) {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return false;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) return false;
    if (ts.isSourceFile(node)) return true;
  }
  return true;
}

const nameOf = (node) => {
  if (node === undefined) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
};

/** Strip the wrappers that do not change a value: parentheses, `as`, `satisfies`. */
function unwrap(node) {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * A literal value as a comparable string, or null when the value is anything
 * else.
 *
 * Anything else includes an identifier holding a constant. Resolving those would
 * widen the write set this check reasons from, and a write set that is too small
 * is what turns rule 2 from a bug detector into a liar, so an unresolvable write
 * disqualifies the whole property instead.
 */
export function literalOf(node) {
  const value = unwrap(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return JSON.stringify(value.text);
  if (ts.isNumericLiteral(value)) return value.text;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (value.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (value.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (
    ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(value.operand)
  ) {
    return `-${value.operand.text}`;
  }
  return null;
}

/**
 * Everything one file says about property names: where they are declared, where
 * they are written, where they are read, and where they are compared.
 */
function readFile(root, file) {
  const source = parse(root, file);
  const declarations = [];
  const writes = [];
  const reads = [];
  const comparisons = [];
  const literals = [];
  const assertedTypes = new Set();

  const siblingsOf = (container) => {
    const required = [];
    const all = new Set();
    for (const member of container.members ?? []) {
      const memberName = nameOf(member.name);
      if (memberName === null) continue;
      all.add(memberName);
      if (ts.isPropertySignature(member) && member.questionToken === undefined) required.push(memberName);
    }
    return { all, required };
  };

  const walk = (node) => {
    // Declarations. Interfaces and type literals are the shapes this repository
    // owns; a class field is counted for the uniqueness census below but is not
    // a candidate, since a constructor writes it out of sight of this check.
    if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
      const name = nameOf(node.name);
      const container = node.parent;
      if (name !== null) {
        const isShape =
          ts.isPropertySignature(node) &&
          (ts.isInterfaceDeclaration(container) || ts.isTypeLiteralNode(container)) &&
          ownedShape(container);
        // A method written as a property is a function, not a fact.
        const isMethod =
          node.type !== undefined &&
          (ts.isFunctionTypeNode(node.type) || ts.isMethodSignature(node));
        declarations.push({
          file,
          name,
          line: lineOf(source, node),
          optional: node.questionToken !== undefined,
          candidate: isShape && !isMethod,
          container: ts.isInterfaceDeclaration(container) ? container.name.text : null,
          siblings: isShape ? siblingsOf(container) : { all: new Set(), required: [] },
        });
      }
    }
    if (ts.isMethodSignature(node)) {
      const name = nameOf(node.name);
      if (name !== null) {
        declarations.push({
          file,
          name,
          line: lineOf(source, node),
          optional: true,
          candidate: false,
          container: null,
          siblings: { all: new Set(), required: [] },
        });
      }
    }

    // Writes in an object literal, and the literal itself, which rule 1 uses to
    // tell a shape this repository builds from one it only describes.
    if (ts.isObjectLiteralExpression(node)) {
      const written = new Set();
      let spread = false;
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          spread = true;
          continue;
        }
        const name = nameOf(property.name);
        if (name === null) continue;
        written.add(name);
        if (ts.isPropertyAssignment(property)) {
          writes.push({
            file,
            name,
            line: lineOf(source, property),
            literal: literalOf(property.initializer),
          });
        } else {
          // Shorthand and methods write a value this check cannot read.
          writes.push({ file, name, line: lineOf(source, property), literal: null });
        }
      }
      literals.push({ file, line: lineOf(source, node), written, spread });
    }

    // `x.prop = value`, including the compound forms.
    if (
      ts.isBinaryExpression(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      writes.push({
        file,
        name: node.left.name.text,
        line: lineOf(source, node),
        literal: node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? literalOf(node.right) : null,
      });
    }

    // Reads. The left of an assignment is a write and was counted as one.
    if (ts.isPropertyAccessExpression(node)) {
      const assigned =
        ts.isBinaryExpression(node.parent) &&
        node.parent.left === node &&
        node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      if (!assigned) reads.push({ file, name: node.name.text, line: lineOf(source, node) });
    }

    // `x.prop === L` and `x.prop !== L`.
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const equals = node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
      for (const [side, other] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        const access = unwrap(side);
        if (!ts.isPropertyAccessExpression(access)) continue;
        const literal = literalOf(other);
        if (literal === null) continue;
        comparisons.push({
          file,
          name: access.name.text,
          line: lineOf(source, node),
          literal,
          equals,
          text: `${access.getText(source)} ${equals ? "===" : "!=="} ${other.getText(source)}`,
        });
      }
    }

    // `switch (x.prop) { case L: }`.
    if (ts.isSwitchStatement(node)) {
      const access = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(access)) {
        for (const clause of node.caseBlock.clauses) {
          if (!ts.isCaseClause(clause)) continue;
          const literal = literalOf(clause.expression);
          if (literal === null) continue;
          comparisons.push({
            file,
            name: access.name.text,
            line: lineOf(source, clause),
            literal,
            equals: true,
            text: `case ${clause.expression.getText(source)} of switch (${access.getText(source)})`,
          });
        }
      }
    }

    // Type assertions name the shapes this repository describes but does not
    // build: a GitHub response, a D1 row. Rule 1 must not report a field of one.
    if (ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type)) {
      assertedTypes.add(node.type.typeName.getText(source));
    }

    ts.forEachChild(node, walk);
  };

  walk(source);
  return { declarations, writes, reads, comparisons, literals, assertedTypes };
}

/** How much of a shape an object literal has to build to count as building it. */
const COVERAGE = 0.6;

/**
 * How many other required fields a shape needs before a literal matching all of
 * them means anything. Two field names in common is a coincidence: `{ digest,
 * version }` in the CLI's proof builder matched an unrelated three-field request
 * body and produced this check's first false positive.
 */
const MIN_SHAPE = 3;

/**
 * Fields nothing writes, and comparisons nothing can satisfy.
 *
 * Returned rather than thrown, and sorted, so the caller prints the whole list
 * at once.
 */
export function unwrittenFields({ root, files = sourceFiles(root) }) {
  const parsed = new Map();
  for (const file of files) parsed.set(file, readFile(root, file));

  // The uniqueness census counts every declaration anywhere, tests included. A
  // name a test declares is a name this check cannot tell apart from the one
  // production declares.
  const declaredCount = new Map();
  const candidates = new Map();
  for (const [file, module] of parsed) {
    for (const declaration of module.declarations) {
      declaredCount.set(declaration.name, (declaredCount.get(declaration.name) ?? 0) + 1);
      if (declaration.candidate && !isTest(file)) candidates.set(declaration.name, declaration);
    }
  }

  const asserted = new Set();
  const shipping = [...parsed.entries()].filter(([file]) => !isTest(file));
  for (const [, module] of shipping) for (const name of module.assertedTypes) asserted.add(name);

  const writesByName = new Map();
  const readsByName = new Map();
  const comparisonsByName = new Map();
  const push = (map, key, value) => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
  };
  for (const [, module] of shipping) {
    for (const write of module.writes) push(writesByName, write.name, write);
    for (const read of module.reads) push(readsByName, read.name, read);
    for (const comparison of module.comparisons) push(comparisonsByName, comparison.name, comparison);
  }

  const findings = [];
  for (const [name, declaration] of candidates) {
    if (declaredCount.get(name) !== 1) continue;
    if (declaration.container !== null && asserted.has(declaration.container)) continue;

    const writes = writesByName.get(name) ?? [];
    const reads = readsByName.get(name) ?? [];

    if (writes.length === 0) {
      if (declaration.optional) continue;
      if (reads.length === 0) continue;
      // Does anything here build this shape? A literal that writes only names
      // this shape declares, and most of the required ones, is a construction of
      // it. Without one the values come from outside: a cast row, a response, a
      // spread of something built elsewhere. Nothing to report either way.
      const others = declaration.siblings.required.filter((s) => s !== name);
      const builders = [];
      for (const [, module] of shipping) {
        for (const literal of module.literals) {
          if (literal.spread || literal.written.size === 0) continue;
          if ([...literal.written].some((w) => !declaration.siblings.all.has(w))) continue;
          const covered = others.filter((s) => literal.written.has(s)).length;
          if (others.length >= MIN_SHAPE && covered / others.length >= COVERAGE) builders.push(literal);
        }
      }
      if (builders.length === 0) continue;
      findings.push({
        rule: 1,
        file: declaration.file,
        line: declaration.line,
        name,
        detail: `read in ${reads.length} place(s) and written nowhere; ${builders[0].file}:${builders[0].line} builds the shape without it`,
      });
      continue;
    }

    // Rule 2 reasons from the set of values shipping code writes, so it needs
    // every write to be readable. One write it cannot read means the set is
    // incomplete, and an incomplete set makes every comparison look impossible.
    if (writes.some((w) => w.literal === null)) continue;
    const values = new Set(writes.map((w) => w.literal));
    for (const comparison of comparisonsByName.get(name) ?? []) {
      const inSet = values.has(comparison.literal);
      if (comparison.equals && !inSet) {
        findings.push({
          rule: 2,
          file: comparison.file,
          line: comparison.line,
          name,
          detail: `${comparison.text} is never true; shipping code only ever writes ${[...values].join(", ")}`,
        });
      } else if (!comparison.equals && inSet && values.size === 1) {
        findings.push({
          rule: 2,
          file: comparison.file,
          line: comparison.line,
          name,
          detail: `${comparison.text} is never true; shipping code only ever writes ${[...values].join(", ")}`,
        });
      } else if (!comparison.equals && !inSet) {
        findings.push({
          rule: 2,
          file: comparison.file,
          line: comparison.line,
          name,
          detail: `${comparison.text} is always true; shipping code only ever writes ${[...values].join(", ")}`,
        });
      }
    }
  }

  findings.sort((a, b) =>
    a.file === b.file ? a.line - b.line || a.name.localeCompare(b.name) : a.file.localeCompare(b.file),
  );
  return findings;
}

/** One line per finding, in the form a reader can jump to. */
export function describe(findings) {
  return findings.map((f) => `${f.file}:${f.line} ${f.name}: ${f.detail}`);
}
