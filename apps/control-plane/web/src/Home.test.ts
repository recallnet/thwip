import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Home } from "./Home.js";

describe("Home", () => {
  it("sells the agent-run CI merge queue and sends a signed-in owner to setup", () => {
    const html = renderToStaticMarkup(
      createElement(Home, {
        me: { organization: { github_login: "recallnet" } },
        signIn: () => undefined,
      }),
    );

    expect(html).toContain("The fastest merge queue for AI-native teams.");
    expect(html).toContain("Your agents ran CI.");
    expect(html).toContain('<span class="mq-hero__line">Your merge queue</span>');
    expect(html).toContain('<span class="mq-hero__line">should use it.</span>');
    expect(html).toContain("14.0s");
    expect(html).toContain("Reuse the proof on the pull request. No extra cloud run.");
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain("The proof commits to the tree");
    expect(html).not.toContain("Thwip runs its own merge queue this way.");
    expect(html).not.toContain("Pick an organization default in the dashboard.");
  });
});
