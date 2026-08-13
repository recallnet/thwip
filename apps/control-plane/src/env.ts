export interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue;
  ASSETS: Fetcher;
  THWIP_ENV: string;
  PUBLIC_ORIGIN: string;
  BUILD_SHA: string;
  /** Unique nonce created once for this exact Wrangler deployment. */
  DEPLOYMENT_ID: string;
  /**
   * How this worker got past the deploy gate, when it did not go the usual way.
   *
   * Empty on an ordinary deploy. A break-glass deploy stamps the guard it
   * excused and why, and `/health` publishes it, so running unreviewed code is a
   * thing production says about itself rather than a thing one terminal knew.
   */
  DEPLOY_EXCEPTION?: string;
  STRIPE_PRICE_MONTHLY: string;
  STRIPE_PRICE_ANNUAL: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_CLIENT_ID: string;
  THWIP_ADMIN_TOKEN: string;
  THWIP_SERVICE_SIGNING_PRIVATE_JWK: string;
  BETTER_AUTH_SECRET: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_BA_WEBHOOK_SECRET?: string;
  GITHUB_SYNC_TOKEN?: string;
  /* Thwip Queue: one Durable Object per repository and base ref, and the
     workflow that drives one integration turn. */
  BRANCH_QUEUE: DurableObjectNamespace<import("./queue/BranchQueue.js").BranchQueue>;
  /** Digest-addressed evidence. Absent in environments that have no bucket. */
  EVIDENCE?: R2Bucket;
}
