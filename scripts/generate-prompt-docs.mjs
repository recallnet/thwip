#!/usr/bin/env node
// Publishes the agent prompts and site copy as markdown so agents can fetch
// them without a browser. Generated from @thwip/prompts so the page, the
// CLI, and these files cannot drift: install.md and faq.md are written, never
// hand-edited, and the dashboard renders the same sources.
import { writeFileSync } from "node:fs";
import { developerSetupPrompt, FAQ_ITEMS } from "../packages/prompts/dist/index.js";

const installOut = new URL("../apps/control-plane/web/public/install.md", import.meta.url).pathname;
writeFileSync(
  installOut,
  `# Set up your machine for thwip

Paste the block below into your coding agent, or run \`thwip setup\` to print
it. It installs the CLI, signs you in with a device code that works over SSH,
and guides you through registering a signing key with GitHub. The agent never
handles your private key.

Setting up a *repository* is a separate prompt, on that project's page in the
dashboard.

\`\`\`
${developerSetupPrompt()}
\`\`\`
`,
);
console.log(`wrote ${installOut}`);

// The FAQ markdown mirrors the dashboard page: same list, same order, same
// inline markup (`code` and **bold**), with the anchor id as a link target.
const faqOut = new URL("../apps/control-plane/web/public/faq.md", import.meta.url).pathname;
writeFileSync(
  faqOut,
  `# thwip FAQ

${FAQ_ITEMS.map((item) => `## ${item.q}\n\n${item.a}\n`).join("\n")}`,
);
console.log(`wrote ${faqOut}`);
