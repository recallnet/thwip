import { describe, expect, it } from "vitest";
import { acquireRunLease, type RunLeasePorts, type RunLeaseSubject } from "./run-lease.js";

/**
 * Nothing minted a lease, so every profile that requires one refused every
 * proof. These say what the CLI now does about that, and that it does nothing
 * at all under the profile that never asked.
 */

const subject: RunLeaseSubject = {
  repositoryId: "1315419165",
  treeOid: "a".repeat(40),
  parentOids: ["b".repeat(40)],
  baseSha: "c".repeat(40),
  deviceKeyId: "SHA256:device",
};

function ports(response: { status: number; body: unknown }): RunLeasePorts & { calls: RunLeaseSubject[] } {
  const calls: RunLeaseSubject[] = [];
  return {
    calls,
    async mint(s) {
      calls.push(s);
      return response;
    },
  };
}

describe("the lease a run happens inside", () => {
  it("asks for nothing under a profile that requires nothing", async () => {
    const p = ports({ status: 200, body: { lease: "should.not.be.used" } });
    expect(await acquireRunLease(false, subject, p)).toBeUndefined();
    expect(p.calls).toHaveLength(0);
  });

  it("names the exact run it is asking a window for", async () => {
    const p = ports({ status: 200, body: { lease: "a.b.c" } });
    expect(await acquireRunLease(true, subject, p)).toBe("a.b.c");
    expect(p.calls[0]).toEqual(subject);
  });

  it("refuses to run when thwip will not mint one", async () => {
    await expect(acquireRunLease(true, subject, ports({ status: 404, body: { error: "project not enabled" } }))).rejects.toThrow(
      /requires a run lease.*project not enabled/s,
    );
  });

  it("refuses an answer with no lease in it, rather than signing without one", async () => {
    await expect(acquireRunLease(true, subject, ports({ status: 200, body: {} }))).rejects.toThrow(
      /answered without one/,
    );
  });

  it("refuses when thwip cannot be reached at all", async () => {
    await expect(
      acquireRunLease(true, subject, {
        async mint() {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    ).rejects.toThrow(/could not be reached/);
  });
});
