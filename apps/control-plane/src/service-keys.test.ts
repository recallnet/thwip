import { afterEach, describe, expect, it } from "vitest";
import { publicJwkFrom, recordActiveKey, verificationKeys } from "./service-keys.js";
import { testD1 } from "../test/d1.js";
import type { D1Like } from "./queue/projection.js";

/**
 * A signature nobody else can check is decoration. This turns the private key
 * the Worker signs with into the public key a reader verifies with, and it must
 * never leak the private half while doing so.
 */
describe("the public half of the signing key", () => {
  const privateJwk = {
    kty: "EC",
    crv: "P-256",
    x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
    y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    d: "jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI",
    kid: "thwip-svc-1",
  };

  it("keeps every field a verifier needs", () => {
    const pub = publicJwkFrom(privateJwk);
    expect(pub).toMatchObject({ kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y, kid: "thwip-svc-1" });
  });

  it("never carries the private scalar", () => {
    expect(publicJwkFrom(privateJwk)).not.toHaveProperty("d");
  });

  it("marks the key as verification-only", () => {
    expect(publicJwkFrom(privateJwk)).toMatchObject({ use: "sig", alg: "ES256" });
  });

  it("refuses a key with no id, because a verifier selects by id", () => {
    const { kid: _drop, ...anonymous } = privateJwk;
    expect(() => publicJwkFrom(anonymous)).toThrow(/kid/i);
  });
});

describe("the keys a reader can verify with", () => {
  const open: Array<{ close(): void }> = [];
  afterEach(() => {
    while (open.length > 0) open.pop()!.close();
  });
  function db(): D1Like {
    const t = testD1();
    open.push(t);
    return t.db as unknown as D1Like;
  }

  const key = (kid: string) => ({ kty: "EC", crv: "P-256", x: "a", y: "b", d: "secret", kid });

  it("publishes the active key", async () => {
    const store = db();
    await recordActiveKey(store, key("thwip-svc-1"));
    const keys = await verificationKeys(store);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kid: "thwip-svc-1", use: "sig" });
    expect(keys[0]).not.toHaveProperty("d");
  });

  it("records the same key twice without duplicating it", async () => {
    const store = db();
    await recordActiveKey(store, key("thwip-svc-1"));
    await recordActiveKey(store, key("thwip-svc-1"));
    expect(await verificationKeys(store)).toHaveLength(1);
  });

  it("can reuse the published health key while D1 maintenance blocks writes", async () => {
    const t = testD1({ upTo: "0031_finish_github_repository_lifecycle.sql" });
    open.push(t);
    await recordActiveKey(t.db, key("thwip-svc-1"));
    t.raw.prepare("UPDATE project_lifecycle_rollout SET maintenance_mode = 1 WHERE id = 1").run();

    await expect(recordActiveKey(t.db, key("thwip-svc-1"))).resolves.toBeUndefined();
    await expect(recordActiveKey(t.db, key("missing-during-maintenance"))).rejects.toThrow(
      "project lifecycle maintenance is active",
    );
  });

  /** The point of the table: a rotation must not orphan what the old key signed. */
  it("keeps a retired key alongside the new one", async () => {
    const store = db();
    await recordActiveKey(store, key("thwip-svc-1"));
    await recordActiveKey(store, key("thwip-svc-2"));
    const kids = (await verificationKeys(store)).map((k) => k.kid).sort();
    expect(kids).toEqual(["thwip-svc-1", "thwip-svc-2"]);
  });
});
