import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signSsh, verifySshSignature } from "./index.js";

const execFileP = promisify(execFile);

let dir: string;
let keyPath: string;
let publicKey: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "thwip-sshsig-test-"));
  keyPath = join(dir, "id_ed25519");
  await execFileP("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-C", "thwip-test"]);
  const { readFile } = await import("node:fs/promises");
  publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sshsig roundtrip", () => {
  it("signs and verifies under the thwip namespace", async () => {
    const message = new TextEncoder().encode("DSSEv1 test message");
    const sig = await signSsh({ privateKeyPath: keyPath, namespace: "thwip-ci-dsse-v1", message });
    expect(sig).toMatch(/^[A-Za-z0-9+/=]+$/);
    const ok = await verifySshSignature({
      publicKey,
      namespace: "thwip-ci-dsse-v1",
      message,
      signatureBase64: sig,
    });
    expect(ok).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const message = new TextEncoder().encode("original");
    const sig = await signSsh({ privateKeyPath: keyPath, namespace: "thwip-ci-dsse-v1", message });
    const ok = await verifySshSignature({
      publicKey,
      namespace: "thwip-ci-dsse-v1",
      message: new TextEncoder().encode("tampered"),
      signatureBase64: sig,
    });
    expect(ok).toBe(false);
  });

  it("rejects a wrong namespace", async () => {
    const message = new TextEncoder().encode("ns test");
    const sig = await signSsh({ privateKeyPath: keyPath, namespace: "thwip-ci-dsse-v1", message });
    const ok = await verifySshSignature({
      publicKey,
      namespace: "git",
      message,
      signatureBase64: sig,
    });
    expect(ok).toBe(false);
  });
});
