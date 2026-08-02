/**
 * SSHSIG verification for Ed25519 keys, used for enrollment proof of
 * possession inside the Worker. The implementation lives in `@thwip/verifier`,
 * which owns the same check for proofs, so the Worker and the checker cannot
 * drift apart on what a valid signature is.
 */
export { ed25519RawFromAuthorizedKey, sha256Fingerprint } from "@thwip/verifier";
export { verifySshSignature as verifySshSigEd25519 } from "@thwip/verifier";
