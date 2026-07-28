/**
 * Minimal SSHSIG verification for Ed25519 keys, used only for enrollment
 * proof-of-possession inside the Worker (no OpenSSH available there).
 * Parses the SSHSIG container and authorized_keys blob; the actual
 * signature check is WebCrypto Ed25519. No cryptographic primitives are
 * implemented here.
 */

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class Reader {
  private off = 0;
  constructor(private buf: Uint8Array) {}
  u32(): number {
    if (this.off + 4 > this.buf.length) throw new Error("truncated");
    const v =
      (this.buf[this.off]! << 24) |
      (this.buf[this.off + 1]! << 16) |
      (this.buf[this.off + 2]! << 8) |
      this.buf[this.off + 3]!;
    this.off += 4;
    return v >>> 0;
  }
  bytes(n: number): Uint8Array {
    if (this.off + n > this.buf.length) throw new Error("truncated");
    const v = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return v;
  }
  string(): Uint8Array {
    return this.bytes(this.u32());
  }
  remaining(): number {
    return this.buf.length - this.off;
  }
}

function encodeSshString(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length);
  out.set(b, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const te = new TextEncoder();
const td = new TextDecoder();

/** Extract the raw Ed25519 public key (32 bytes) from an authorized_keys line. */
export function ed25519RawFromAuthorizedKey(publicKey: string): Uint8Array {
  const parts = publicKey.trim().split(/\s+/);
  if (parts[0] !== "ssh-ed25519" || !parts[1]) throw new Error("not an ssh-ed25519 key");
  const blob = b64decode(parts[1]);
  const r = new Reader(blob);
  const keyType = td.decode(r.string());
  if (keyType !== "ssh-ed25519") throw new Error("key blob type mismatch");
  const raw = r.string();
  if (raw.length !== 32) throw new Error("bad ed25519 key length");
  return raw;
}

export async function verifySshSigEd25519(args: {
  publicKey: string;
  namespace: string;
  message: Uint8Array;
  signatureBase64: string;
}): Promise<boolean> {
  try {
    const raw = ed25519RawFromAuthorizedKey(args.publicKey);
    const blob = b64decode(args.signatureBase64);
    const r = new Reader(blob);
    const magic = r.bytes(6);
    if (td.decode(magic) !== "SSHSIG") return false;
    const version = r.u32();
    if (version !== 1) return false;
    const sigPubBlob = r.string();
    const namespace = r.string();
    if (td.decode(namespace) !== args.namespace) return false;
    const reserved = r.string();
    const hashAlg = r.string();
    const hashAlgName = td.decode(hashAlg);
    if (hashAlgName !== "sha512" && hashAlgName !== "sha256") return false;
    const sigBlob = r.string();

    // Signature public key must match the enrolled key.
    const pr = new Reader(sigPubBlob);
    if (td.decode(pr.string()) !== "ssh-ed25519") return false;
    const sigPubRaw = pr.string();
    if (sigPubRaw.length !== raw.length || sigPubRaw.some((b, i) => b !== raw[i])) return false;

    const sr = new Reader(sigBlob);
    if (td.decode(sr.string()) !== "ssh-ed25519") return false;
    const rawSig = sr.string();
    if (rawSig.length !== 64) return false;

    const hashed = new Uint8Array(
      await crypto.subtle.digest(hashAlgName === "sha512" ? "SHA-512" : "SHA-256", args.message as BufferSource),
    );
    const signedData = concat(
      te.encode("SSHSIG"),
      encodeSshString(te.encode(args.namespace)),
      encodeSshString(reserved),
      encodeSshString(hashAlg),
      encodeSshString(hashed),
    );

    const key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, rawSig as BufferSource, signedData as BufferSource);
  } catch {
    return false;
  }
}

export async function sha256Fingerprint(publicKey: string): Promise<string> {
  const parts = publicKey.trim().split(/\s+/);
  if (!parts[1]) throw new Error("invalid public key");
  const blob = b64decode(parts[1]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", blob as BufferSource));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return `SHA256:${btoa(bin).replace(/=+$/, "")}`;
}
