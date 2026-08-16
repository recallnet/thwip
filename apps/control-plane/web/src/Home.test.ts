import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Home, OperatingMeasures } from "./Home.js";
import type { PublicReusedCiMetrics } from "./metrics.js";

function render() {
  return renderToStaticMarkup(
    createElement(Home, {
      me: { organization: { github_login: "recallnet" } },
      signIn: () => undefined,
    }),
  );
}

describe("Home", () => {
  it("sells the agent-run CI merge queue and sends a signed-in owner to setup", () => {
    const html = render();

    expect(html).toContain("A merge queue for agent-built software.");
    expect(html).toContain(
      '<span class="mq-hero__line mq-hero__line--lead">A merge queue built for agent workflows.</span>',
    );
    expect(html).toContain("Thwip makes agents prove their work before it enters the queue");
    expect(html).toContain("reuses that proof to avoid expensive cloud CI whenever it can");
    expect(html).toContain("Agents save time. You save money. Simple.");
    expect(html).toContain("Cloud queues repeat work that your agents already finished in parallel.");
    expect(html).toContain("Loading measured results");
    expect(html).not.toContain("14.0s");
    expect(html).not.toContain("28.0s");
    expect(html).not.toContain("73s");
    expect(html).toContain("Reuse the proof on the pull request. No extra cloud run.");
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain("The proof commits to the tree");
    expect(html).not.toContain("Thwip runs its own merge queue this way.");
    expect(html).not.toContain("Pick an organization default in the dashboard.");
    expect(html).not.toContain("Stays controlled");
    expect(html).not.toContain("One writer for");
    expect(html).not.toContain("Branch writer");
  });

  it("states the benefit without promising unsupported savings", () => {
    const html = render();
    const hero = html.slice(html.indexOf('<section class="mq-row mq-row--open">'), html.indexOf("</section>"));

    expect(hero).toMatch(/agents prove their work/i);
    expect(hero).toMatch(/avoid expensive cloud CI whenever it can/i);
    expect(hero).toMatch(/agents save time\. you save money\. simple\./i);
    expect(hero).not.toMatch(/guaranteed|always|save[s]? \$|developer[- ]time savings/i);
  });

  it("keeps the agent-workflow benefit in page metadata", () => {
    const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

    expect(index).toContain("A merge queue built for agent workflows");
    expect(index).toContain("makes agents prove their work before it enters the queue");
    expect(index).toContain("avoid expensive cloud CI whenever it can");
    expect(index).not.toMatch(/guaranteed|developer[- ]time savings|save[s]? \$/i);
  });

  it("shows API-backed measurements and names exactly what they measure", () => {
    const metrics: PublicReusedCiMetrics = {
      status: "partial",
      minimumMergedProofs: 10,
      signedSuiteDurationMs: 3_000_000,
      signedWallClockDurationMs: 3_660_000,
      verificationOverheadMs: 125,
      mergedProofs: 12,
      knownReusedMerges: 14,
      unmeasuredMergedProofs: 2,
    };
    const html = renderToStaticMarkup(createElement(OperatingMeasures, { metrics, error: null }));

    expect(html).toContain("1h 1m");
    expect(html).toContain("CI that ran on dev machines, not hosted runners");
    expect(html).toContain("125ms");
    expect(html).toContain("What verifying them cost");
    expect(html).toContain("Across 12 merges");
    expect(html).toContain("On thwip\u2019s servers. In Actions, all that\u2019s left is a signature check.");
    expect(html).not.toMatch(/older merge|partial history/i);
    expect(html).not.toMatch(/money saved|developer waiting time/i);
  });

  /**
   * A count of our merges tells a first-time reader nothing about their repo.
   * The per-merge trade does, because they can hold it against their own.
   */
  it("reports the per-merge trade instead of a raw merge count", () => {
    const metrics: PublicReusedCiMetrics = {
      status: "partial",
      minimumMergedProofs: 10,
      signedSuiteDurationMs: 3_000_000,
      signedWallClockDurationMs: 3_660_000,
      verificationOverheadMs: 24_000,
      mergedProofs: 12,
      knownReusedMerges: 14,
      unmeasuredMergedProofs: 2,
    };
    const html = renderToStaticMarkup(createElement(OperatingMeasures, { metrics, error: null }));

    expect(html).toContain("5m 5s");
    expect(html).toContain("2s");
    expect(html).toContain("Per merge");
    expect(html).not.toContain("Merges that reused a proof");
    expect(html).not.toContain("signed merge records");
  });

  /** Every merge predates the measurement, so there is no average to state. */
  it("omits the per-merge trade when nothing is measured", () => {
    const html = renderToStaticMarkup(
      createElement(OperatingMeasures, {
        metrics: {
          status: "partial",
          minimumMergedProofs: 10,
          signedSuiteDurationMs: 0,
          signedWallClockDurationMs: 0,
          verificationOverheadMs: 0,
          mergedProofs: 0,
          knownReusedMerges: 4,
          unmeasuredMergedProofs: 4,
        },
        error: null,
      }),
    );
    expect(html).not.toContain("Per merge");
    expect(html).not.toContain("NaN");
  });

  it("shows no estimate while the public sample is too small", () => {
    const html = renderToStaticMarkup(
      createElement(OperatingMeasures, {
        metrics: { status: "insufficient-sample", minimumMergedProofs: 10 },
        error: null,
      }),
    );
    expect(html).toContain("Public totals appear after 10 measured merges");
    expect(html).toContain("No estimate is shown before then");
    expect(html).not.toContain("<article");
  });

  it("distinguishes loading from an unavailable measurement", () => {
    const loading = renderToStaticMarkup(createElement(OperatingMeasures, { metrics: null, error: null }));
    const unavailable = renderToStaticMarkup(
      createElement(OperatingMeasures, { metrics: null, error: "network failed" }),
    );
    expect(loading).toContain("Loading measured results");
    expect(unavailable).toContain("Measured results are unavailable");
  });

  /**
   * The page's left edge is the merge lane. Every section hangs off it, and
   * each one carries the tick that says the lane reached that point.
   */
  it("runs the lane down every section", () => {
    const html = render();

    expect(html.match(/<section class="mq-row/g)?.length).toBe(6);
    expect(html.match(/class="mq-row__body"/g)?.length).toBe(6);
    expect(html).toContain('<section class="mq-row mq-row--open">');
    expect(html).toContain('<section class="mq-row mq-row--upstream">');
    expect(html).toContain('<section class="mq-row mq-row--end">');
  });

  /**
   * The queue junction is nested in the upstream field, while the next marker
   * belongs to the protected lane. Centering the queue marker on its own left
   * edge keeps both junctions on the same axis at every breakpoint.
   */
  it("centers every queue junction marker on the shared lane axis", () => {
    const css = readFileSync(new URL("./notary.css", import.meta.url), "utf8");
    const queueMarker = css.match(/\.mq-lane::before\s*\{(?<rule>[^}]*)\}/)?.groups?.rule;
    const sectionMarker = css.match(/\.mq-row__body::after\s*\{(?<rule>[^}]*)\}/)?.groups?.rule;
    const narrowMarker = css.match(/\.mq-row::before\s*\{(?<rule>[^}]*)\}/)?.groups?.rule;

    expect(css).toContain("--mq-lane-marker-size: 8px;");
    expect(queueMarker).toContain("left: 0;");
    expect(queueMarker).toContain("transform: translateX(-50%);");
    for (const marker of [queueMarker, sectionMarker, narrowMarker]) {
      expect(marker).toContain("width: var(--mq-lane-marker-size);");
      expect(marker).toContain("height: var(--mq-lane-marker-size);");
    }
  });

  it("keeps the queue junction compact and evenly spaced", () => {
    const css = readFileSync(new URL("./notary.css", import.meta.url), "utf8");
    const upstreamBody = css.match(/\.mq-row--upstream \.mq-row__body\s*\{(?<rule>[^}]*)\}/)?.groups?.rule;
    const queueLane = css.match(/\.mq-lane\s*\{(?<rule>[^}]*)\}/)?.groups?.rule;

    expect(upstreamBody).toContain("padding-bottom: 0;");
    expect(queueLane).toContain("padding: 15px 10px;");
    expect(queueLane).not.toContain("padding-top:");
  });

  it("uses one continuous lane and branch-like agent tags", () => {
    const css = readFileSync(new URL("./notary.css", import.meta.url), "utf8");
    const lane = css.match(/\.mq-row__body\s*\{(?<rule>[^}]*)\}/)?.groups?.rule;
    const agentRow = css.match(/\.mq-agent\s*\{(?<rule>[^}]*)\}/)?.groups?.rule;
    const agentTag = css.match(/\.mq-agent__id\s*\{(?<rule>[^}]*)\}/)?.groups?.rule;
    const agentFeed = css.match(/\.mq-agent__feed\s*\{(?<rule>[^}]*)\}/)?.groups?.rule;

    expect(lane).toContain("border-left: 2px solid var(--ink);");
    expect(css).not.toContain("border-left: 1px solid var(--rule);");
    expect(agentTag).toContain("border: 1px solid var(--ink);");
    expect(agentTag).toContain("border-radius: 999px;");
    expect(agentFeed).toContain("margin-right: -14px;");
    expect(agentRow).not.toContain("border-bottom:");
  });

  /**
   * A real agent's verdict is the only claim on the page with a signer
   * behind it. It says the agent kept using the queue after the experiment,
   * and it stays sourced; the link to the full numbers returns when the blog
   * post leaves draft.
   */
  it("quotes an agent who kept using the queue after the experiment, sourced but not yet linked", () => {
    const html = render();

    expect(html).toContain("saved about 40 to 60 hours of waiting");
    expect(html).toContain("After the experiment, I kept using Thwip.");
    expect(html).toContain("A coding agent who still uses Thwip, July 2026");
    expect(html).not.toContain("Read the agent's full numbers");
    expect(html).toContain('class="mq-quote"');
  });

  /**
   * Four profiles that differ only in prose read as four synonyms. The meter
   * says what actually changes: how much evidence the lane demands.
   */
  it("shows each profile's evidence strength", () => {
    const html = render();

    expect(html).toContain('class="mq-strength" aria-hidden="true"');
    expect(html.match(/mq-strength__on/g)?.length).toBe(1 + 2 + 3 + 4);
  });
});
