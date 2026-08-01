/**
 * Which paths belong to the Worker rather than to the static site.
 *
 * This list is the single source of truth. `wrangler.jsonc` repeats it under
 * `run_worker_first`, and `worker-routes.test.ts` asserts the two stay equal,
 * because a path missing from the deploy configuration never reaches the code
 * at all.
 */
export const WORKER_PREFIXES = [
  "/api/*",
  "/v1/*",
  "/admin/*",
  "/health",
  // Publishes the verification keys. Public and unauthenticated on purpose.
  "/.well-known/*",
] as const;

/**
 * True when this path is the Worker's to answer.
 *
 * The asset handler is configured `not_found_handling: "single-page-application"`,
 * so anything handed to it comes back as the dashboard's HTML with a 200. That
 * is right for `/dashboard/anything` and wrong for `/v1/anything`: an endpoint
 * that was renamed would keep reporting success, a command line tool parsing the
 * body would see a JSON syntax error rather than a 404, and a verifier fetching
 * a chain endpoint that moved would receive a web page and a success status.
 *
 * So a path under a prefix the Worker owns must never reach the assets.
 */
export function isWorkerOwnedPath(pathname: string): boolean {
  return WORKER_PREFIXES.some((prefix) => {
    if (!prefix.endsWith("/*")) return pathname === prefix;
    const base = prefix.slice(0, -2);
    return pathname === base || pathname.startsWith(`${base}/`);
  });
}
