# Agent Merge Queue Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the proof-led homepage with a repository-owner homepage that
sells Thwip Queue as the merge path for CI runs agents have already completed.

**Architecture:** `Home.tsx` becomes a static product page with a dashboard
CTA, measured operating evidence, a parallel-agent queue diagram, and accurate
profile descriptions. `notary.css` adds homepage-specific queue styles while
retaining the shared public-page rules used by FAQ and installation pages. A
server-rendered component test holds the page's core message and CTA contract.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, existing notary CSS.

---

### Task 1: Lock the homepage message with a component test

**Files:**
- Create: `apps/control-plane/web/src/Home.test.ts`
- Test: `apps/control-plane/web/src/Home.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Home } from "./Home.js";

describe("Home", () => {
  it("sells the agent-run CI merge queue and sends a signed-in owner to setup", () => {
    const html = renderToStaticMarkup(createElement(Home, {
      me: { organization: { github_login: "recallnet" } },
      signIn: () => undefined,
    }));

    expect(html).toContain("Your agents ran CI. Your merge queue should use it.");
    expect(html).toContain("14.0s");
    expect(html).toContain("Fast reuses the proof the pull request already carries.");
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain("The proof commits to the tree");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails because the new homepage is absent**

Run: `pnpm exec vitest run apps/control-plane/web/src/Home.test.ts --reporter=dot`

Expected: FAIL with the missing homepage thesis.

### Task 2: Replace the homepage content and structure

**Files:**
- Modify: `apps/control-plane/web/src/Home.tsx`
- Test: `apps/control-plane/web/src/Home.test.ts`

- [ ] **Step 1: Replace the replay and proof-inspection fields with the product page**

The component must render the thesis, operating metrics, parallel agent queue
diagram, four profiles, protected-branch controls, signed record explanation,
and a repository-setup CTA. The signed-in CTA uses `/dashboard`; the signed-out
CTA calls the supplied `signIn` callback.

- [ ] **Step 2: Run the homepage test and confirm it passes**

Run: `pnpm exec vitest run apps/control-plane/web/src/Home.test.ts --reporter=dot`

Expected: PASS with one test.

### Task 3: Give the queue page its own visual grammar

**Files:**
- Modify: `apps/control-plane/web/src/notary.css`
- Test: `apps/control-plane/web/src/Home.test.ts`

- [ ] **Step 1: Add scoped `mq-` styles**

Add styles for the thesis hero, metric ledger, parallel agent rows, protected
merge lane, profile cards, evidence ledger, and responsive small-screen layout.
Keep the existing `.nt-*` shared styles intact because FAQ and installation
pages use them.

- [ ] **Step 2: Run the web typecheck and production build**

Run: `pnpm --filter @thwip/control-plane run build`

Expected: exit code 0 and a Vite production build.

### Task 4: Verify the shipped page and commit it

**Files:**
- Modify: `docs/superpowers/specs/2026-08-05-agent-merge-queue-homepage-design.md`
- Modify: `docs/superpowers/plans/2026-08-05-agent-merge-queue-homepage.md`
- Modify: `apps/control-plane/web/src/Home.tsx`
- Modify: `apps/control-plane/web/src/notary.css`
- Create: `apps/control-plane/web/src/Home.test.ts`

- [ ] **Step 1: Run the focused homepage test**

Run: `pnpm exec vitest run apps/control-plane/web/src/Home.test.ts --reporter=dot`

Expected: PASS.

- [ ] **Step 2: Run full repository checks**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

Expected: all commands exit 0.

- [ ] **Step 3: Inspect the rendered homepage**

Run: `pnpm --filter @thwip/control-plane run build && test -f apps/control-plane/dist/client/index.html`

Expected: build exits 0 and the public entry artifact exists.

- [ ] **Step 4: Commit the atomic homepage rewrite**

Run: `git add apps/control-plane/web/src/Home.tsx apps/control-plane/web/src/Home.test.ts apps/control-plane/web/src/notary.css docs/superpowers/specs/2026-08-05-agent-merge-queue-homepage-design.md docs/superpowers/plans/2026-08-05-agent-merge-queue-homepage.md && git commit -m "feat(home): sell the agent merge queue"`

Expected: one commit containing the tested homepage rewrite.
