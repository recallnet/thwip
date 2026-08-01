import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { integrationReceiptContent, integrationReceiptSigningBytes } from "./integration-receipt.js";

/**
 * What a device signs when it reports an integration run.
 *
 * The device signs these bytes and the queue verifies them, from two packages
 * that cannot see each other's tests. They agreed once by coincidence: the
 * command line tool signed whatever its receipt object held, and the control
 * plane signed five fields it picked out again by hand. A field added on either
 * side would have refused every receipt in production while both packages'
 * suites stayed green.
 *
 * So the shape lives here, and this pins it. If the bytes change, both signer
 * and verifier change together and this test says so.
 */

const RECEIPT = {
  assignmentId: "asg_01",
  assignmentDigest: `sha256:${"a".repeat(64)}`,
  candidateTreeOid: "b".repeat(40),
  deviceKeyId: "key_01",
  suites: [
    { name: "test", outcome: "passed" },
    { name: "lint", outcome: "passed" },
  ],
};

describe("the bytes a device signs for an integration receipt", () => {
  it("covers the receipt and nothing else", () => {
    expect(integrationReceiptContent(RECEIPT)).toEqual({
      assignmentId: "asg_01",
      assignmentDigest: `sha256:${"a".repeat(64)}`,
      candidateTreeOid: "b".repeat(40),
      deviceKeyId: "key_01",
      suites: [
        { name: "test", outcome: "passed" },
        { name: "lint", outcome: "passed" },
      ],
    });
  });

  /**
   * Anything the caller sends alongside the receipt, a signature included, is
   * outside what was signed. Otherwise a signature would cover itself.
   */
  it("ignores whatever the caller sent alongside", () => {
    const withExtras = { ...RECEIPT, signature: "sig", attemptId: "att_9", note: "hello" };
    expect(integrationReceiptSigningBytes(withExtras)).toEqual(integrationReceiptSigningBytes(RECEIPT));
  });

  it("changes when the receipt changes", () => {
    const elsewhere = { ...RECEIPT, candidateTreeOid: "c".repeat(40) };
    expect(integrationReceiptSigningBytes(elsewhere)).not.toEqual(integrationReceiptSigningBytes(RECEIPT));
  });

  it("distinguishes a suite that failed from one that passed", () => {
    const failed = { ...RECEIPT, suites: [{ name: "test", outcome: "failed" }, RECEIPT.suites[1]!] };
    expect(integrationReceiptSigningBytes(failed)).not.toEqual(integrationReceiptSigningBytes(RECEIPT));
  });
});

/**
 * The signer and the verifier must reach these bytes through this function, not
 * rebuild them. Rebuilding is what made them agree by luck in the first place.
 */
describe("who builds those bytes", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));

  function tsFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) tsFiles(full, out);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(full);
    }
    return out;
  }

  it("is this package alone", () => {
    for (const dir of [`${root}packages/cli/src`, `${root}apps/control-plane/src`]) {
      for (const file of tsFiles(dir)) {
        const text = readFileSync(file, "utf8");
        expect(
          /QUEUE_PREDICATE_TYPES\.integrationRun/.test(text),
          `${file.slice(root.length)} builds the receipt signing bytes itself; call integrationReceiptSigningBytes`,
        ).toBe(false);
      }
    }
  });
});
