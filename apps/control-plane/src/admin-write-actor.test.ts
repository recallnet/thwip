import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Who wrote the row.
 *
 * Two operator-token routes wrote rows that named nobody. `POST /admin/seed`
 * created an organization, a project, an active policy and repository grants
 * from a request body, with no record of who asked. Installation sync writes
 * all four from what GitHub says, so the route was a second way to make the
 * same rows that answered to a shared secret instead of to an installation,
 * and nothing called it.
 *
 * The device kill switch stays, because an operator revoking a key is a thing
 * that has to be possible. It now writes the actor into the same field the
 * dashboard's own revocation uses, so a revoked key says who revoked it either
 * way.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
  "utf8",
);

describe("operator writes", () => {
  it("has no hand-seeding route", () => {
    expect(src).not.toContain('"/admin/seed"');
  });

  it("records the actor on an operator revocation", () => {
    const route = src.slice(src.indexOf('app.post("/v1/devices/:keyId/revoke"'));
    const handler = route.slice(0, route.indexOf("\n});"));
    expect(handler).toContain("revoked by operator token");
  });
});
