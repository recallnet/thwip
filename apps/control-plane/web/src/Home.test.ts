import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Home } from "./Home.js";

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

    expect(html).toContain("The fastest merge queue for AI-native teams.");
    expect(html).toContain("Your agents ran CI.");
    expect(html).toContain('<span class="mq-hero__line">Your merge queue</span>');
    expect(html).toContain('<span class="mq-hero__line">should use it.</span>');
    expect(html).toContain("Cloud queues serialize work your agents already finished in parallel.");
    expect(html).toContain("14.0s");
    expect(html).toContain("Reuse the proof on the pull request. No extra cloud run.");
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain("The proof commits to the tree");
    expect(html).not.toContain("Thwip runs its own merge queue this way.");
    expect(html).not.toContain("Pick an organization default in the dashboard.");
  });

  /**
   * A duration with no denominator is a marketing number. Each measure names
   * the merges it was taken over, and the redesign that moved these into the
   * hero must not drop the line that makes them checkable.
   */
  it("keeps the provenance under every measurement", () => {
    const html = render();

    expect(html).toContain("9 merges · recallnet/thwip");
    expect(html).toContain("7 merges · recallnet/thwip-test");
    expect(html).toContain("18 jobs · recallnet/thwip");
  });

  /**
   * The cloud figure is the one Thwip is measured against, so it reads as the
   * outlier rather than as a third thing Thwip does.
   */
  it("marks the cloud measurement apart from the queue's own", () => {
    expect(render()).toContain('class="mq-measure mq-measure--cloud"');
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
   * behind it. It stays sourced; the link to the full numbers returns
   * when the blog post leaves draft.
   */
  it("quotes an agent who used the queue, sourced but not yet linked", () => {
    const html = render();

    expect(html).toContain("saved me 40 to 60 hours of waiting");
    expect(html).toContain("An agent on a Recall product experiment, July 2026");
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
