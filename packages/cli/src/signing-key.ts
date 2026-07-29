import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface SigningKey {
  /** private key path for ssh-keygen -Y sign */
  privateKeyPath: string;
  /** authorized_keys-format public key */
  publicKey: string;
  /** OpenSSH SHA256 fingerprint; this is the proof's key id */
  fingerprint: string;
  /** how it was found, for explaining the choice */
  source: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function fingerprintOf(publicKeyPath: string): Promise<string> {
  const { stdout } = await execFileP("ssh-keygen", ["-lf", publicKeyPath]);
  const fp = stdout.trim().split(/\s+/)[1];
  if (!fp?.startsWith("SHA256:")) throw new Error(`cannot read fingerprint of ${publicKeyPath}`);
  return fp;
}

async function load(privateKeyPath: string, source: string): Promise<SigningKey | null> {
  const pub = `${privateKeyPath}.pub`;
  if (!(await exists(privateKeyPath)) || !(await exists(pub))) return null;
  const publicKey = (await readFile(pub, "utf8")).trim();
  if (!publicKey.startsWith("ssh-ed25519")) return null;
  return { privateKeyPath, publicKey, fingerprint: await fingerprintOf(pub), source };
}

/**
 * Find the signing key this machine already has. GitHub owns the binding
 * between a key and an identity, so thwip never mints or stores keys — it
 * only needs to know which local private key corresponds to a public key the
 * user has registered with GitHub as a signing key.
 *
 * Order: explicit override, then git's own SSH signing key (already correct
 * on any machine that signs commits), then the usual OpenSSH defaults.
 */
export async function discoverSigningKey(cwd: string, override?: string): Promise<SigningKey | null> {
  if (override) {
    const k = await load(override.replace(/\.pub$/, ""), "configured");
    if (k) return k;
    throw new Error(`configured signing key not usable: ${override}`);
  }

  try {
    const { stdout: format } = await execFileP("git", ["config", "--get", "gpg.format"], { cwd });
    if (format.trim() === "ssh") {
      const { stdout: key } = await execFileP("git", ["config", "--get", "user.signingkey"], { cwd });
      const path = key.trim().replace(/^~/, homedir()).replace(/\.pub$/, "");
      const k = await load(path, "git user.signingkey");
      if (k) return k;
    }
  } catch {
    /* no git signing configured */
  }

  for (const name of ["id_ed25519_sk", "id_ed25519"]) {
    const k = await load(join(homedir(), ".ssh", name), `~/.ssh/${name}`);
    if (k) return k;
  }
  return null;
}

/** Public signing keys GitHub currently lists for this user. */
export async function githubSigningKeys(login: string): Promise<Array<{ id: number; key: string; title: string }>> {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}/ssh_signing_keys?per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "thwip-cli",
      ...(process.env["GH_TOKEN"] ? { authorization: `Bearer ${process.env["GH_TOKEN"]}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`cannot list signing keys for ${login}: ${res.status}`);
  return (await res.json()) as Array<{ id: number; key: string; title: string }>;
}

/** Fingerprint of an authorized_keys-format public key, via ssh-keygen. */
export async function fingerprintOfPublicKey(publicKey: string): Promise<string> {
  const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "thwip-fp-"));
  try {
    const p = join(dir, "k.pub");
    await writeFile(p, publicKey.endsWith("\n") ? publicKey : `${publicKey}\n`);
    return await fingerprintOf(p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
