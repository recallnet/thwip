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

    expect(html).toContain("Your agents ran CI.");
    expect(html).toContain("Your merge queue should use it.");
    expect(html).toContain("14.0s");
    expect(html).toContain("Fast reuses the proof the pull request already carries.");
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain("The proof commits to the tree");
  });
});
