import { describe, expect, it } from "vitest";
import { isMembership, selectPrincipal, type PrincipalRow } from "./viewer-scope.js";

/**
 * A principal row says a person is inside an organization's world. It stopped
 * saying they are a member of it: installation sync writes one for every
 * outside collaborator too, with `github_org_role` set to `outside`, so reading
 * membership off the row's existence handed one repository's invitation the
 * whole organization.
 */

function row(overrides: Partial<PrincipalRow> = {}): PrincipalRow {
  return {
    principalId: "prn_1",
    organizationId: "org_acme",
    githubOrgId: "10",
    githubLogin: "acme",
    githubOrgRole: "member",
    activated: true,
    ...overrides,
  };
}

describe("what a principal row says", () => {
  it("counts owner, member and an unsynced null as membership", () => {
    for (const role of ["owner", "member", "admin", null]) expect(isMembership(role)).toBe(true);
  });

  it("does not count an outside collaborator as membership", () => {
    expect(isMembership("outside")).toBe(false);
  });
});

describe("which principal a session acts as", () => {
  const member = row({ principalId: "prn_member", organizationId: "org_bravo", githubOrgId: "20", githubLogin: "bravo" });
  const outside = row({ principalId: "prn_outside", githubOrgRole: "outside" });

  it("prefers a membership when the session names no organization", () => {
    expect(selectPrincipal([outside, member], null)?.principalId).toBe("prn_member");
  });

  it("selects the organization the session names, membership or not", () => {
    expect(selectPrincipal([outside, member], "acme")?.principalId).toBe("prn_outside");
    expect(selectPrincipal([outside, member], "10")?.principalId).toBe("prn_outside");
  });

  /** Somebody who belongs to no organization still acts as somebody. */
  it("selects the collaborator principal when there is no membership at all", () => {
    expect(selectPrincipal([outside], null)?.principalId).toBe("prn_outside");
  });

  it("has nobody to select when there are no rows", () => {
    expect(selectPrincipal([], null)).toBe(null);
  });

  /** A name that matches nothing must not silently act as somebody else's org. */
  it("falls back to a membership when the named organization is not one of theirs", () => {
    expect(selectPrincipal([outside, member], "charlie")?.principalId).toBe("prn_member");
  });
});
