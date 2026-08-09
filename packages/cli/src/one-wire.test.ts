import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planQueueCommand } from "./queue-commands.js";

/**
 * The request the CLI builds, held against the route that answers it.
 *
 * `thwip queue join` sent `sponsorLogin` and no `headSha`. The route has always
 * required `headSha` and has never read `sponsorLogin`, so the command was
 * answered 400 every time anybody ran it, and it shipped that way.
 *
 * Nothing caught it because both sides were tested against themselves. The
 * planner's tests assert the body the planner builds, written beside the
 * planner. The route's tests post a body the route's own tests compose. Each
 * stayed correct against its own idea of the wire the whole time, which is
 * exactly the shape that lets two correct halves disagree. This reads the route
 * as source and fails when the CLI sends a field it does not read, or leaves out
 * one it demands.
 */

const ROUTES = fileURLToPath(new URL("../../../apps/control-plane/src/queue/routes.ts", import.meta.url));

/** The one handler, cut out so a `body.` in a neighbouring route cannot count. */
function handler(path: string): string {
  const source = readFileSync(ROUTES, "utf8");
  const start = source.indexOf(`app.post("${path}"`);
  expect(start, `no handler for ${path}`).toBeGreaterThan(-1);
  const next = source.indexOf("\n  app.", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

/** What the handler declares it will read out of the JSON body. */
function accepted(slice: string): string[] {
  const declaration = /as \{([^}]*)\};/.exec(slice.slice(slice.indexOf("c.req.json()")));
  expect(declaration, "the handler does not declare a body shape").not.toBeNull();
  return [...(declaration?.[1] ?? "").matchAll(/(\w+)\?:/g)].map((m) => m[1]!);
}

/** What it refuses the request for missing. */
function required(slice: string): string[] {
  return [...slice.matchAll(/typeof body\.(\w+) !==/g)].map((m) => m[1]!);
}

describe("thwip queue join, against the route that answers it", () => {
  const slice = handler("/v1/queue/:repositoryId/entries");
  const plan = planQueueCommand(["join", "--repo", "acme/widgets", "--pr", "7"], { nonce: "test-nonce" });
  if (!plan.ok) throw new Error(plan.message);
  const sent = Object.keys(plan.plan.body ?? {});

  it("reads a handler that still declares a body, so a rewrite cannot pass by accident", () => {
    expect(accepted(slice)).toContain("pullRequestNumber");
    expect(required(slice)).toContain("pullRequestNumber");
  });

  it("sends every field the route refuses the request for missing", () => {
    for (const field of required(slice)) expect(sent, `join never sends ${field}`).toContain(field);
  });

  it("sends nothing the route does not read", () => {
    for (const field of sent) expect(accepted(slice), `the route ignores ${field}`).toContain(field);
  });
});

describe("who sponsors an entry", () => {
  it("is not something the caller may name any more", () => {
    // The same pull request queued through the route and through the webhook
    // was getting two entries with two different sponsors, so the author is now
    // derived server-side. A flag that quietly does nothing is worse than none.
    const refused = planQueueCommand(["join", "--repo", "acme/widgets", "--pr", "7", "--sponsor", "someone"], { nonce: "test-nonce" });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.message).toContain("author");
  });
});

describe("the head sha join queues", () => {
  it("is carried in the body, resolved by the caller when it is not given", () => {
    const plan = planQueueCommand(["join", "--repo", "acme/widgets", "--pr", "7"], { nonce: "test-nonce" });
    expect(plan.ok && plan.plan.body?.["headSha"]).toBe("{headSha}");
  });

  it("is taken as given when it is, and refused when it is not an object id", () => {
    const sha = "0".repeat(40);
    const given = planQueueCommand(["join", "--repo", "acme/widgets", "--pr", "7", "--head-sha", sha], { nonce: "test-nonce" });
    expect(given.ok && given.plan.body?.["headSha"]).toBe(sha);
    expect(planQueueCommand(["join", "--repo", "acme/widgets", "--pr", "7", "--head-sha", "HEAD"], { nonce: "test-nonce" }).ok).toBe(false);
  });
});
