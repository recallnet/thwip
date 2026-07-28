import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END = "-----END SSH SIGNATURE-----";

/** Convert ssh-keygen ASCII armor output to standard base64 of the binary SSHSIG blob. */
export function armorToBase64(armored: string): string {
  const body = armored.replace(ARMOR_BEGIN, "").replace(ARMOR_END, "").replace(/\s+/g, "");
  if (body.length === 0) throw new Error("empty SSH signature armor");
  return body;
}

export function base64ToArmor(b64: string): string {
  const lines = b64.match(/.{1,70}/g) ?? [];
  return `${ARMOR_BEGIN}\n${lines.join("\n")}\n${ARMOR_END}\n`;
}

/** Sign message bytes with an OpenSSH private key under a namespace. Returns standard base64 of the SSHSIG blob. */
export async function signSsh(args: {
  privateKeyPath: string;
  namespace: string;
  message: Uint8Array;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thwip-sign-"));
  try {
    const msgPath = join(dir, "message");
    await writeFile(msgPath, args.message);
    await execFileP("ssh-keygen", ["-Y", "sign", "-f", args.privateKeyPath, "-n", args.namespace, msgPath]);
    const armored = await readFile(`${msgPath}.sig`, "utf8");
    return armorToBase64(armored);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runWithStdin(cmd: string, argv: string[], stdin: Uint8Array): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1 }));
    child.stdin.end(Buffer.from(stdin));
  });
}

/** Verify an SSHSIG (standard base64 blob) over message bytes with an authorized_keys-format public key. */
export async function verifySshSignature(args: {
  publicKey: string;
  namespace: string;
  message: Uint8Array;
  signatureBase64: string;
}): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "thwip-verify-"));
  try {
    const allowedSigners = join(dir, "allowed_signers");
    const sigPath = join(dir, "sig");
    const [keyType, keyBlob] = args.publicKey.trim().split(/\s+/);
    if (!keyType || !keyBlob) throw new Error("invalid public key");
    await writeFile(allowedSigners, `thwip namespaces="${args.namespace}" ${keyType} ${keyBlob}\n`);
    await writeFile(sigPath, base64ToArmor(args.signatureBase64));
    const { code } = await runWithStdin(
      "ssh-keygen",
      ["-Y", "verify", "-f", allowedSigners, "-I", "thwip", "-n", args.namespace, "-s", sigPath],
      args.message,
    );
    return code === 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
