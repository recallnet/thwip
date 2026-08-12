import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueueControls, QueueTableHeading, TablePagination, queueReadPath } from "./Queue.js";
import { Panel } from "./ui.js";

describe("project Queue view", () => {
  it("requests independent server-backed pages", () => {
    expect(queueReadPath("1315419165", "refs/heads/release/v2", 3, 7)).toBe(
      "/v1/queue/1315419165?ref=refs%2Fheads%2Frelease%2Fv2&entriesPage=3&transitionsPage=7",
    );
  });

  it("keeps the pause action compact and puts its required reason in a dialog", () => {
    const html = renderToStaticMarkup(
      createElement(QueueControls, {
        repositoryId: "1315419165",
        baseRef: "refs/heads/main",
        paused: false,
        rebaselineRequired: false,
        onChanged: vi.fn(),
      }),
    );

    expect(html).toContain("Pause merging");
    expect(html).toContain("<dialog");
    expect(html).toContain("Pause merging on this branch?");
    expect(html).toContain("<textarea");
    expect(html).toContain("required=\"\"");
    expect(html).not.toContain('placeholder="why merging should stop"');

    const resumed = renderToStaticMarkup(
      createElement(QueueControls, {
        repositoryId: "1315419165",
        baseRef: "refs/heads/main",
        paused: true,
        rebaselineRequired: false,
        onChanged: vi.fn(),
      }),
    );
    expect(resumed).toContain("Resume merging");
    expect(resumed).not.toContain("<dialog");
  });

  it("places the queue action beside its status in the section header", () => {
    const html = renderToStaticMarkup(
      createElement(Panel, {
        title: "Queue",
        meta: "Nothing integrating",
        action: createElement("button", null, "Pause merging"),
        children: createElement("p", null, "Queue data"),
      }),
    );
    expect(html).toContain('class="thwip-section__tools"');
    expect(html.indexOf("Nothing integrating")).toBeLessThan(html.indexOf("Pause merging"));
    expect(html.indexOf("Pause merging")).toBeLessThan(html.indexOf("Queue data"));
  });

  it("names and explains both data sets", () => {
    const entries = renderToStaticMarkup(
      createElement(QueueTableHeading, {
        id: "entries",
        title: "Pull requests in this queue",
        description: "Ordered by the queue.",
      }),
    );
    const history = renderToStaticMarkup(
      createElement(QueueTableHeading, {
        id: "history",
        title: "Signed branch history",
        description: "Newest records appear first.",
      }),
    );

    expect(entries).toContain("Pull requests in this queue");
    expect(entries).toContain("Ordered by the queue.");
    expect(history).toContain("Signed branch history");
    expect(history).toContain("Newest records appear first.");
  });

  it("reports the selected page and disables paging at its boundaries", () => {
    const first = renderToStaticMarkup(
      createElement(TablePagination, {
        label: "Signed branch history",
        page: { page: 1, pageSize: 20, total: 45, totalPages: 3 },
        onPage: vi.fn(),
      }),
    );
    expect(first).toContain('aria-label="Signed branch history pages"');
    expect(first).toContain("Page 1 of 3 · 45 records");
    expect(first).toMatch(/disabled=""[^>]*>Previous/);
    expect(first).not.toMatch(/disabled=""[^>]*>Next/);
  });
});
