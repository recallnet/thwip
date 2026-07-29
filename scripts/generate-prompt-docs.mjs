#!/usr/bin/env node
// Publishes the agent prompts as markdown so agents can fetch them without a
// browser. Generated from @thwip/prompts so the page, the CLI, and these
// files cannot drift.
import { writeFileSync } from "node:fs";
import { developerSetupPrompt } from "../packages/prompts/dist/index.js";

const out = new URL("../apps/control-plane/web/public/install.md", import.meta.url).pathname;
writeFileSync(
  out,
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
console.log(`wrote ${out}`);
