/**
 * Print what the worker should publish about how it was deployed.
 *
 * Empty on an ordinary deploy, which is what clears a previous exception: one
 * that had to be remembered to be cleared would outlive its reason, and the
 * reader who found it later would have no way to tell.
 *
 * `predeploy.mjs` has already refused if the declaration is malformed, so this
 * only formats.
 */
import { execFileSync } from "node:child_process";

import { exceptionStamp, parseBreakGlass } from "./break-glass.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

process.stdout.write(
  exceptionStamp(parseBreakGlass(process.env.THWIP_BREAK_GLASS), {
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    head: git("rev-parse", "--short", "HEAD"),
    at: new Date().toISOString(),
  }),
);
