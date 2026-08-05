/**
 * Migration numbers are the repository's human-readable ordering guarantee.
 * D1 records complete filenames, so the historic collisions must keep their
 * names forever; the lint rule baselines those exact pairs and rejects any new
 * ambiguity without pretending the old files can be renamed safely.
 */
import { readdirSync } from "node:fs";

export const HISTORICAL_COLLISIONS = new Map([
  ["0008", ["0008_policy_activation_source.sql", "0008_queue_projection_serves_reads.sql"]],
  ["0023", ["0023_remove_queue_runtime_selectors.sql", "0023_status_comment_per_pull_request.sql"]],
]);

function migrationNumber(name) {
  return /^(\d+)_/.exec(name)?.[1] ?? null;
}

function sameNames(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function migrationNumberCollisions(names) {
  const byNumber = new Map();
  for (const name of names.filter((candidate) => candidate.endsWith(".sql")).sort()) {
    const number = migrationNumber(name);
    if (number === null) continue;
    const group = byNumber.get(number) ?? [];
    group.push(name);
    byNumber.set(number, group);
  }

  const findings = [];
  const numbers = new Set([...byNumber.keys(), ...HISTORICAL_COLLISIONS.keys()]);
  for (const number of [...numbers].sort()) {
    const group = byNumber.get(number) ?? [];
    const baseline = HISTORICAL_COLLISIONS.get(number);
    if (group.length === 1 && baseline === undefined) continue;
    if (baseline !== undefined && sameNames(group, baseline)) continue;
    findings.push({ number, names: group, baseline: baseline ?? null });
  }
  return findings;
}

export function readMigrationNumberCollisions(dir) {
  return migrationNumberCollisions(readdirSync(dir));
}

export function describeMigrationNumberCollision(finding) {
  const lines = [
    `migration number ${finding.number} is used by:`,
    ...finding.names.map((name) => `  migrations/${name}`),
  ];
  if (finding.baseline !== null) {
    lines.push(
      "the only permitted historical filenames for that number are:",
      ...finding.baseline.map((name) => `  migrations/${name}`),
    );
  }
  lines.push("choose the next unused number; never rename an applied migration");
  return lines.join("\n");
}
