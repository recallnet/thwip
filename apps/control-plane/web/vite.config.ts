import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { initPrompt } from "@thwip/prompts";

const installDoc = `# Set up your machine for thwip

Paste the block below into your coding agent. It runs one safe, repeatable init
command for a first checkout or another machine, then reports any human action
still needed. The agent never handles your private key.

\`\`\`
${initPrompt()}
\`\`\`
`;

const promptDocs: Plugin = {
  name: "prompt-docs",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/install.md") return next();
      response.setHeader("content-type", "text/markdown; charset=utf-8");
      response.end(installDoc);
    });
  },
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "install.md", source: installDoc });
  },
};

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), promptDocs],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/v1": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
});
