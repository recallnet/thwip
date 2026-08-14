import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const RELEASES = "https://dl.dagger.io/dagger/releases";

/**
 * thwip provisions its own Dagger engine so using thwip never means
 * installing a second global toolchain. The version comes from the signed
 * policy, so a project's approved toolchain is pinned rather than "latest",
 * and the download is checked against the published checksum before it is
 * ever executed.
 */
function daggerCacheDir(version: string): string {
  const base = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  return join(base, "thwip", "dagger", version);
}

function platformSlug(): { os: string; arch: string } {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
  return { os, arch };
}

async function expectedChecksum(version: string, file: string): Promise<string> {
  const res = await fetch(`${RELEASES}/${version}/checksums.txt`);
  if (!res.ok) throw new Error(`cannot fetch dagger checksums for ${version}: ${res.status}`);
  for (const line of (await res.text()).split("\n")) {
    const [sum, name] = line.trim().split(/\s+/);
    if (name === file && sum) return sum;
  }
  throw new Error(`no checksum published for ${file}`);
}

/** Path to a verified dagger binary, downloading it once if needed. */
export async function ensureDagger(version: string): Promise<string> {
  const dir = daggerCacheDir(version);
  const bin = join(dir, process.platform === "win32" ? "dagger.exe" : "dagger");
  if (existsSync(bin)) return bin;

  const { os, arch } = platformSlug();
  const file = `dagger_v${version}_${os}_${arch}.tar.gz`;
  const [expected, res] = await Promise.all([
    expectedChecksum(version, file),
    fetch(`${RELEASES}/${version}/${file}`),
  ]);
  if (!res.ok) throw new Error(`cannot download ${file}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`dagger ${version} checksum mismatch: expected ${expected}, got ${actual}`);
  }

  const staging = await mkdtemp(join(tmpdir(), "thwip-dagger-"));
  try {
    const tarball = join(staging, file);
    await writeFile(tarball, bytes);
    await execFileP("tar", ["-xzf", tarball, "-C", staging]);
    await mkdir(dir, { recursive: true });
    const extracted = join(staging, process.platform === "win32" ? "dagger.exe" : "dagger");
    await chmod(extracted, 0o755);
    await rename(extracted, bin);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return bin;
}

/** Dagger needs a container runtime; say so plainly rather than failing deep. */
export async function requireContainerRuntime(): Promise<void> {
  try {
    await execFileP("docker", ["info"], { timeout: 20_000 });
  } catch {
    throw new Error(
      [
        "no container runtime reachable (dagger needs one).",
        "  start Docker Desktop, or: colima start",
        "  or set DOCKER_HOST to a running daemon",
      ].join("\n"),
    );
  }
}

export interface DaggerSuiteResult {
  id: string;
  status: "passed" | "failed";
  durationMs: number;
}

/**
 * Run one module function per required suite. Everything about how a suite
 * executes — matrices, services, platforms, caching — lives in the module,
 * in a real language, rather than in a configuration dialect thwip invented.
 */
export async function runDaggerSuites(args: {
  bin: string;
  module: string;
  suites: string[];
  cwd: string;
}): Promise<DaggerSuiteResult[]> {
  const results: DaggerSuiteResult[] = [];
  for (const id of args.suites) {
    const started = Date.now();
    process.stderr.write(`\n[thwip] suite ${id}: dagger call -m ${args.module} ${id}\n`);
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(args.bin, ["call", "-m", args.module, id], {
        cwd: args.cwd,
        stdio: "inherit",
        env: process.env,
      });
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? 1));
    });
    results.push({ id, status: code === 0 ? "passed" : "failed", durationMs: Date.now() - started });
  }
  return results;
}
