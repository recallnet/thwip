import { randomUUID } from "node:crypto";

const DEPLOYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validDeploymentId(value) {
  return typeof value === "string" && DEPLOYMENT_ID_PATTERN.test(value);
}

/** A unique causal marker generated exactly once for each deploy invocation. */
export function deploymentId(uuid = randomUUID) {
  const value = uuid();
  if (!validDeploymentId(value)) throw new Error("could not create a valid deployment id");
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(deploymentId());
