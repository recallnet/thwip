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
    expect(html).toContain('<span class="mq-hero__line">Your agents already ran CI locally.</span>');
    expect(html).toContain(
      '<span class="mq-hero__line">Merge faster, and avoid repeat CI costs by letting them prove it.</span>',
    );
    expect(html).toContain("Thwip verifies signed evidence from those agent runs against your policy.");
    expect(html).toContain("the protected merge queue moves without repeating the same checks in cloud CI");
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
  });

  it("states the benefit without promising unsupported savings", () => {
    const html = render();
    const hero = html.slice(html.indexOf('<section class="mq-row mq-row--open">'), html.indexOf("</section>"));

    expect(hero).toMatch(/merge faster/i);
    expect(hero).toMatch(/avoid repeat CI costs/i);
    expect(hero).toMatch(/when that evidence is enough/i);
    expect(hero).not.toMatch(/guaranteed|always|save[s]? \$|developer[- ]time savings/i);
  });

  it("keeps the speed and repeat-CI cost benefit in page metadata", () => {
    const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

    expect(index).toContain("Merge faster and avoid repeat CI costs");
    expect(index).toContain("Thwip verifies signed evidence from agent-run checks");
    expect(index).toContain("When your policy accepts it");
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
    expect(html).toContain("Verified local CI reused");
    expect(html).toContain("125ms");
    expect(html).toContain("Proof verification overhead");
    expect(html).toContain("Merges that reused a proof");
    expect(html).toContain("12 measured · 2 older merges have no timing");
    expect(html).not.toMatch(/money saved|developer waiting time/i);
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

    expect(html.match(/<section class="mq-row/g)?.length).toBe(7);
    expect(html.match(/class="mq-row__body"/g)?.length).toBe(7);
    expect(html).toContain('<section class="mq-row mq-row--open">');
    expect(html).toContain('<section class="mq-row mq-row--upstream">');
    expect(html).toContain('<section class="mq-row mq-row--end">');
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
