/**
 * Asking thwip to open a window before the tests run.
 *
 * Under `fast` a proof says the suites passed on this tree, and nothing more.
 * Every other profile says the run happened for this turn rather than being
 * reused from an earlier commit, and the lease is what carries that: a token
 * naming this repository, this tree, these parents, this base and this device,
 * issued before the run and checked by the verifier against the run it claims
 * to cover.
 *
 * It is requested before the suites start, on purpose. A lease minted after
 * the run finished is old evidence in a fresh wrapper, and the verifier
 * refuses one.
 */

export interface RunLeaseSubject {
  readonly repositoryId: string;
  readonly treeOid: string;
  readonly parentOids: readonly string[];
  readonly baseSha: string;
  readonly deviceKeyId: string;
}

export interface RunLeasePorts {
  /** POST /v1/run-leases, or whatever a test substitutes for it. */
  mint(subject: RunLeaseSubject): Promise<{ readonly status: number; readonly body: unknown }>;
}

/**
 * The lease to attach to this proof, or nothing when the policy does not ask
 * for one. Refuses rather than returning nothing when the policy does ask:
 * signing a proof the project will reject wastes a full test run and reads as
 * a thwip failure at merge time.
 */
export async function acquireRunLease(
  required: boolean,
  subject: RunLeaseSubject,
  ports: RunLeasePorts,
): Promise<string | undefined> {
  if (!required) return undefined;
  let response: { status: number; body: unknown };
  try {
    response = await ports.mint(subject);
  } catch (error) {
    throw new Error(
      `this project requires a run lease and thwip could not be reached to mint one: ${String(error)}`,
    );
  }
  if (response.status !== 200) {
    const detail = (response.body as { error?: unknown } | null)?.error;
    throw new Error(
      `this project requires a run lease and thwip refused to mint one (${response.status}${
        typeof detail === "string" ? `: ${detail}` : ""
      })`,
    );
  }
  const lease = (response.body as { lease?: unknown } | null)?.lease;
  if (typeof lease !== "string" || lease.length === 0) {
    throw new Error("this project requires a run lease and thwip answered without one");
  }
  return lease;
}

/** The real call. */
export function httpLeasePorts(endpoint: string, authHeader: string | null): RunLeasePorts {
  return {
    async mint(subject) {
      const response = await fetch(`${endpoint}/v1/run-leases`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authHeader === null ? {} : { authorization: authHeader }),
        },
        body: JSON.stringify({
          repositoryId: subject.repositoryId,
          treeOid: subject.treeOid,
          parentOids: [...subject.parentOids],
          baseSha: subject.baseSha,
          deviceKeyId: subject.deviceKeyId,
        }),
      });
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    },
  };
}
