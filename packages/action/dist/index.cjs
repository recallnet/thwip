"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/.pnpm/canonicalize@2.1.0/node_modules/canonicalize/lib/canonicalize.js
var require_canonicalize = __commonJS({
  "../../node_modules/.pnpm/canonicalize@2.1.0/node_modules/canonicalize/lib/canonicalize.js"(exports2, module2) {
    "use strict";
    module2.exports = function serialize(object) {
      if (typeof object === "number" && isNaN(object)) {
        throw new Error("NaN is not allowed");
      }
      if (typeof object === "number" && !isFinite(object)) {
        throw new Error("Infinity is not allowed");
      }
      if (object === null || typeof object !== "object") {
        return JSON.stringify(object);
      }
      if (object.toJSON instanceof Function) {
        return serialize(object.toJSON());
      }
      if (Array.isArray(object)) {
        const values2 = object.reduce((t, cv, ci) => {
          const comma = ci === 0 ? "" : ",";
          const value = cv === void 0 || typeof cv === "symbol" ? null : cv;
          return `${t}${comma}${serialize(value)}`;
        }, "");
        return `[${values2}]`;
      }
      const values = Object.keys(object).sort().reduce((t, cv) => {
        if (object[cv] === void 0 || typeof object[cv] === "symbol") {
          return t;
        }
        const comma = t.length === 0 ? "" : ",";
        return `${t}${comma}${serialize(cv)}:${serialize(object[cv])}`;
      }, "");
      return `{${values}}`;
    };
  }
});

// src/main.ts
var import_node_fs2 = require("node:fs");

// ../../node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/buffer_utils.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var strictDecoder = new TextDecoder("utf-8", { fatal: true });
var MAX_INT32 = 2 ** 32;
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0), buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers)
    buf.set(buffer, i), i += buffer.length;
  return buf;
}
var NON_ASCII = /[^\x00-\x7f]/;
function encode(string2) {
  if (typeof string2 == "string" && string2.length >= 128) {
    if (NON_ASCII.test(string2))
      throw new TypeError("non-ASCII string encountered in encode()");
    return encoder.encode(string2);
  }
  const bytes = new Uint8Array(string2.length);
  for (let i = 0; i < string2.length; i++) {
    const code = string2.charCodeAt(i);
    if (code > 127)
      throw new TypeError("non-ASCII string encountered in encode()");
    bytes[i] = code;
  }
  return bytes;
}
function decodeBase64(encoded, url = false) {
  if (Uint8Array.fromBase64)
    return Uint8Array.fromBase64(encoded, { alphabet: url ? "base64url" : "base64" });
  if (url) {
    if (encoded.includes("+") || encoded.includes("/"))
      throw new TypeError("Invalid base64url");
    encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  }
  const binary = atob(encoded), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ../../node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/util/errors.js
var JOSEError = class extends Error {
  static code = "ERR_JOSE_GENERIC";
  code = "ERR_JOSE_GENERIC";
  constructor(message3, options) {
    super(message3, options), this.name = this.constructor.name, Error.captureStackTrace?.(this, this.constructor);
  }
};
var JOSEAlgNotAllowed = class extends JOSEError {
  static code = "ERR_JOSE_ALG_NOT_ALLOWED";
  code = "ERR_JOSE_ALG_NOT_ALLOWED";
};
var JOSENotSupported = class extends JOSEError {
  static code = "ERR_JOSE_NOT_SUPPORTED";
  code = "ERR_JOSE_NOT_SUPPORTED";
};
var JWSInvalid = class extends JOSEError {
  static code = "ERR_JWS_INVALID";
  code = "ERR_JWS_INVALID";
};
var JWKSInvalid = class extends JOSEError {
  static code = "ERR_JWKS_INVALID";
  code = "ERR_JWKS_INVALID";
};
var JWKSNoMatchingKey = class extends JOSEError {
  static code = "ERR_JWKS_NO_MATCHING_KEY";
  code = "ERR_JWKS_NO_MATCHING_KEY";
  constructor(message3 = "no applicable key found in the JSON Web Key Set", options) {
    super(message3, options);
  }
};
var JWKSMultipleMatchingKeys = class extends JOSEError {
  [Symbol.asyncIterator] = async function* () {
  };
  static code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
  code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
  constructor(message3 = "multiple matching keys found in the JSON Web Key Set", options) {
    super(message3, options);
  }
};
var JWSSignatureVerificationFailed = class extends JOSEError {
  static code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  constructor(message3 = "signature verification failed", options) {
    super(message3, options);
  }
};

// ../../node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/util/base64url.js
var invalid = "The input to be decoded is not correctly encoded.";
function decode(input) {
  try {
    return decodeBase64(typeof input == "string" ? input : decoder.decode(input), true);
  } catch (cause) {
    throw new TypeError(invalid, { cause });
  }
}

// ../../node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/validate.js
function isObject(input) {
  if (typeof input != "object" || input === null || Object.prototype.toString.call(input) !== "[object Object]")
    return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
function isJwkSet(input) {
  return isObject(input) && Array.isArray(input.keys) && Array.from(input.keys).every(isObject);
}
function isDisjoint(...headers) {
  const parameters = /* @__PURE__ */ new Set();
  for (const header of headers)
    if (header)
      for (const parameter of Object.keys(header)) {
        if (parameters.has(parameter))
          return false;
        parameters.add(parameter);
      }
  return true;
}
function decodeBase64url(value, label, ErrorClass) {
  try {
    return decode(value);
  } catch {
    throw new ErrorClass(`Failed to base64url decode the ${label}`);
  }
}
function encodeBase64url(value, label, ErrorClass) {
  try {
    return encode(value);
  } catch {
    throw new ErrorClass(`The ${label} is not a valid base64url string`);
  }
}
function parseJoseHeader(b64, ErrorClass, message3) {
  let parsed;
  try {
    parsed = JSON.parse(strictDecoder.decode(decode(b64)));
  } catch {
    throw new ErrorClass(message3);
  }
  if (!isObject(parsed))
    throw new ErrorClass(message3);
  return parsed;
}
var JWS_RECOGNIZED = { __proto__: null, b64: true };
function validateAlgorithms(option, algorithms) {
  if (algorithms !== void 0 && (!Array.isArray(algorithms) || algorithms.some((s) => typeof s != "string")))
    throw new TypeError(`"${option}" option must be an array of strings`);
  return algorithms === void 0 ? void 0 : new Set(algorithms);
}
function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
  if (joseHeader.crit !== void 0 && protectedHeader?.crit === void 0)
    throw new Err('"crit" (Critical) Header Parameter MUST be integrity protected');
  if (!protectedHeader || protectedHeader.crit === void 0)
    return [];
  if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input != "string" || input.length === 0))
    throw new Err('"crit" (Critical) Header Parameter MUST be an array of non-empty strings when present');
  const recognized = recognizedOption === void 0 ? recognizedDefault : { __proto__: null, ...recognizedOption, ...recognizedDefault };
  for (const parameter of protectedHeader.crit) {
    if (!(parameter in recognized))
      throw new JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
    if (!Object.hasOwn(joseHeader, parameter) || joseHeader[parameter] === void 0)
      throw new Err(`Extension Header Parameter "${parameter}" is missing`);
    if (recognized[parameter] && (!Object.hasOwn(protectedHeader, parameter) || protectedHeader[parameter] === void 0))
      throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
  }
  return protectedHeader.crit;
}
function validateB64(protectedHeader, extensions) {
  if (extensions.includes("b64")) {
    const b64 = protectedHeader.b64;
    if (typeof b64 != "boolean")
      throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
    return b64;
  }
  return true;
}

// ../../node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/key.js
var tag = (key) => key[Symbol.toStringTag];
var jwkMatchesOp = (entry, key, usage) => {
  const { alg } = entry;
  if (key.use !== void 0) {
    const expected = usage === "sign" || usage === "verify" ? "sig" : "enc";
    if (key.use !== expected)
      throw new TypeError(`Invalid key for this operation, its "use" must be "${expected}" when present`);
  }
  if (key.alg !== void 0 && key.alg !== alg)
    throw new TypeError(`Invalid key for this operation, its "alg" must be "${alg}" when present`);
  if (Array.isArray(key.key_ops)) {
    const expectedKeyOp = usage === "encrypt" || usage === "decrypt" ? entry.ops?.[usage === "encrypt" ? 0 : 1] : usage;
    if (expectedKeyOp && !key.key_ops.includes(expectedKeyOp))
      throw new TypeError(`Invalid key for this operation, its "key_ops" must include "${expectedKeyOp}" when present`);
  }
};
async function prepareKey(entry, key, usage) {
  const { alg, secret } = entry, privateKey = usage === "decrypt" || usage === "sign";
  if (secret && key instanceof Uint8Array)
    return key;
  let normalized, keyObject;
  if (isObject(key)) {
    if (normalized = normalizeJwk(key), typeof normalized.kty != "string")
      throw invalidKeyType(alg, key, secret);
    if (!(secret ? normalized.kty === "oct" && typeof normalized.k == "string" : normalized.kty !== "oct" && (privateKey ? normalized.kty === "AKP" && typeof normalized.priv == "string" || typeof normalized.d == "string" : normalized.d === void 0 && normalized.priv === void 0)))
      throw new TypeError(secret ? 'JSON Web Key for symmetric algorithms must have JWK "kty" (Key Type) equal to "oct" and the JWK "k" (Key Value) present' : `JSON Web Key for this operation must be a ${privateKey ? "private" : "public"} JWK`);
    if (jwkMatchesOp(entry, normalized, usage), normalized.kty === "oct")
      return decode(normalized.k);
    if (!Object.isFrozen(key)) {
      const { key_ops } = key;
      Array.isArray(key_ops) && Object.freeze(key_ops), Object.freeze(key);
    }
  } else {
    if (!isKeyLike(key))
      throw invalidKeyType(alg, key, secret);
    const expectedType = secret ? "secret" : privateKey ? "private" : "public";
    if (key.type !== expectedType && (secret || ["secret", "public", "private"].includes(key.type)))
      throw new TypeError(`${tag(key)} instances must be of type "${expectedType}" for the ${alg} algorithm`);
    if (isCryptoKey(key))
      return key;
    if (keyObject = key, keyObject.type === "secret")
      return keyObject.export();
  }
  cache ||= /* @__PURE__ */ new WeakMap();
  const cacheKey = key;
  let cached = cache.get(cacheKey);
  if (cached?.[alg])
    return cached[alg];
  if (cached || cache.set(cacheKey, cached = {}), keyObject && typeof keyObject.toCryptoKey == "function") {
    const isPublic = keyObject.type === "public", crv = nist[keyObject.asymmetricKeyDetails?.namedCurve], params = entry.resolve?.({ crv, asymmetricKeyType: keyObject.asymmetricKeyType }) ?? entry.subtle;
    return cached[alg] = keyObject.toCryptoKey(params, isPublic, entry.usages[isPublic ? 0 : 1]);
  }
  return normalized ??= keyObject.export({ format: "jwk" }), normalized.alg = alg, cached[alg] = await jwkToKey(entry, normalized);
}
var cache;
var nist = {
  __proto__: null,
  prime256v1: "P-256",
  secp384r1: "P-384",
  secp521r1: "P-521"
};
var isCryptoKey = (key) => {
  if (key?.[Symbol.toStringTag] === "CryptoKey")
    return true;
  try {
    return key instanceof CryptoKey;
  } catch {
    return false;
  }
};
var isKeyObject = (key) => key?.[Symbol.toStringTag] === "KeyObject";
var isKeyLike = (key) => isCryptoKey(key) || isKeyObject(key);
function message(msg, actual, ...types) {
  if (types.length > 2) {
    const last = types.pop();
    msg += `one of type ${types.join(", ")}, or ${last}.`;
  } else types.length === 2 ? msg += `one of type ${types[0]} or ${types[1]}.` : msg += `of type ${types[0]}.`;
  return actual == null ? msg += ` Received ${actual}` : typeof actual == "function" && actual.name ? msg += ` Received function ${actual.name}` : typeof actual == "object" && actual != null && actual.constructor?.name && (msg += ` Received an instance of ${actual.constructor.name}`), msg;
}
function invalidKeyType(alg, actual, secret) {
  const types = ["CryptoKey", "KeyObject", "JSON Web Key"];
  return secret && types.push("Uint8Array"), new TypeError(message(`Key for the ${alg} algorithm must be `, actual, ...types));
}
var unusable = (name, prop = "algorithm.name") => new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`);
function checkUsage(key, usage) {
  if (usage && !key.usages.includes(usage))
    throw new TypeError(`CryptoKey does not support this operation, its usages must include ${usage}.`);
}
function checkModulusLength(alg, key) {
  const { modulusLength } = key.algorithm;
  if (typeof modulusLength != "number" || modulusLength < 2048)
    throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
}
function checkCryptoKey(key, expected, usage) {
  const algorithm = key.algorithm;
  if (algorithm.name !== expected.name)
    throw unusable(expected.name);
  if (expected.hash && algorithm.hash?.name !== expected.hash)
    throw unusable(expected.hash, "algorithm.hash");
  if (expected.namedCurve && algorithm.namedCurve !== expected.namedCurve)
    throw unusable(expected.namedCurve, "algorithm.namedCurve");
  if (expected.length !== void 0 && algorithm.length !== expected.length)
    throw unusable(expected.length, "algorithm.length");
  checkUsage(key, usage);
}
function snapshotJwk(jwk) {
  return { __proto__: null, ...jwk };
}
function normalizeJwk(jwk) {
  const normalized = snapshotJwk(jwk);
  if (normalized.ext !== void 0 && typeof normalized.ext != "boolean")
    throw new TypeError('"ext" (Extractable) Parameter must be a boolean');
  if (normalized.key_ops !== void 0) {
    const value = normalized.key_ops, keyOps = Array.isArray(value) ? [...value] : void 0;
    if (!keyOps || keyOps.some((operation) => typeof operation != "string") || new Set(keyOps).size !== keyOps.length)
      throw new TypeError('"key_ops" (Key Operations) Parameter must be an array of unique strings');
    normalized.key_ops = keyOps;
  }
  return normalized;
}
async function jwkToKey(entry, jwk, extractable) {
  if (!entry.kty.includes(jwk.kty))
    throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
  const algorithm = entry.resolve?.({ kty: jwk.kty, crv: jwk.crv }) ?? entry.subtle, isPrivate = !!(jwk.d || jwk.priv), keyData = { ...jwk, ext: extractable ?? jwk.ext };
  return keyData.kty !== "AKP" && delete keyData.alg, delete keyData.use, crypto.subtle.importKey("jwk", keyData, algorithm, keyData.ext ?? !isPrivate, jwk.key_ops ?? entry.usages[isPrivate ? 1 : 0]);
}
async function rawKey(key, expected, usage, extractable = false) {
  return key instanceof Uint8Array && (key = await crypto.subtle.importKey("raw", key, expected, extractable, [usage])), checkCryptoKey(key, expected, usage), key;
}

// ../../node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/key_descriptor.js
function table(entries) {
  const out = { __proto__: null };
  for (const alg in entries)
    out[alg] = { ...entries[alg], alg };
  return out;
}

// ../../node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/jws_algorithms.js
var sig = [["verify"], ["sign"]];
function hmac(bits) {
  const subtle = { name: "HMAC", hash: `SHA-${bits}` };
  return { kty: ["oct"], secret: true, subtle, signing: subtle, usages: sig };
}
function rsa(bits, saltLength) {
  const subtle = { name: saltLength ? "RSA-PSS" : "RSASSA-PKCS1-v1_5", hash: `SHA-${bits}` };
  return {
    kty: ["RSA"],
    subtle,
    signing: saltLength ? { ...subtle, saltLength } : subtle,
    usages: sig,
    minRsaBits: 2048
  };
}
function ecdsa(crv, bits) {
  return {
    kty: ["EC"],
    crv,
    subtle: { name: "ECDSA", namedCurve: crv },
    signing: { name: "ECDSA", hash: `SHA-${bits}` },
    usages: sig
  };
}
function eddsa() {
  const subtle = { name: "Ed25519" };
  return {
    kty: ["OKP"],
    crv: "Ed25519",
    subtle,
    signing: subtle,
    usages: sig
  };
}
function mldsa(bits) {
  const subtle = { name: `ML-DSA-${bits}` };
  return {
    kty: ["AKP"],
    subtle,
    signing: subtle,
    usages: sig
  };
}
var JWS = table({
  HS256: hmac(256),
  HS384: hmac(384),
  HS512: hmac(512),
  RS256: rsa(256),
  RS384: rsa(384),
  RS512: rsa(512),
  PS256: rsa(256, 32),
  PS384: rsa(384, 48),
  PS512: rsa(512, 64),
  ES256: ecdsa("P-256", 256),
  ES384: ecdsa("P-384", 384),
  ES512: ecdsa("P-521", 512),
  EdDSA: eddsa(),
  Ed25519: eddsa(),
  "ML-DSA-44": mldsa(44),
  "ML-DSA-65": mldsa(65),
  "ML-DSA-87": mldsa(87)
});
function jwsAlgorithm(alg) {
  const entry = typeof alg == "string" ? JWS[alg] : void 0;
  if (!entry)
    throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  return entry;
}

// ../../node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/jws_verify.js
function prepareVerify(options) {
  return [options && validateAlgorithms("algorithms", options.algorithms), options?.crit];
}
function parseProtectedHeader(encodedProtected) {
  return encodedProtected === void 0 ? {} : parseJoseHeader(encodedProtected, JWSInvalid, "JWS Protected Header is invalid");
}
function encodeCompactUnencodedPayload(payload) {
  try {
    return encode(payload);
  } catch {
    throw new JWSInvalid("JWS Compact Serialization payload must use only ASCII characters");
  }
}
async function verifySignature(jws, shared, key, encodeUnencodedPayload, parsedProtected) {
  const { protected: encodedProtected, header, payload: inputPayload } = jws, parsedProt = parsedProtected ?? parseProtectedHeader(encodedProtected);
  if (!isDisjoint(parsedProt, header))
    throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
  const joseHeader = { ...parsedProt, ...header }, b64 = validateB64(parsedProt, validateCrit(JWSInvalid, JWS_RECOGNIZED, shared[1], parsedProt, joseHeader)), { alg } = joseHeader;
  if (typeof alg != "string" || !alg)
    throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
  if (shared[0] && !shared[0].has(alg))
    throw new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
  if (b64) {
    if (typeof inputPayload != "string")
      throw new JWSInvalid("JWS Payload must be a string");
  } else if (typeof inputPayload != "string" && !(inputPayload instanceof Uint8Array))
    throw new JWSInvalid("JWS Payload must be a string or an Uint8Array instance");
  const signingPayload = b64 || typeof inputPayload != "string" ? inputPayload : encodeUnencodedPayload(inputPayload);
  let resolvedKey = false;
  typeof key == "function" && (key = await key(parsedProt, jws), resolvedKey = true);
  const entry = jwsAlgorithm(alg), data = concat(encodedProtected !== void 0 ? encode(encodedProtected) : new Uint8Array(), encode("."), typeof signingPayload == "string" ? shared[2] ??= encodeBase64url(signingPayload, "payload", JWSInvalid) : signingPayload), signature = decodeBase64url(jws.signature, "signature", JWSInvalid), k = await prepareKey(entry, key, "verify"), cryptoKey = await rawKey(k, entry.subtle, "verify");
  entry.minRsaBits && checkModulusLength(entry.alg, cryptoKey);
  let verified = false;
  try {
    verified = await crypto.subtle.verify(entry.signing, cryptoKey, signature, data);
  } catch {
  }
  if (!verified)
    throw new JWSSignatureVerificationFailed();
  const result = { payload: typeof signingPayload == "string" ? decodeBase64url(signingPayload, "payload", JWSInvalid) : signingPayload };
  return encodedProtected !== void 0 && (result.protectedHeader = parsedProt), header !== void 0 && (result.unprotectedHeader = header), resolvedKey ? [{ ...result, key: k }, b64] : [result, b64];
}
async function verifyCompact(jws, shared, key) {
  if (jws instanceof Uint8Array && (jws = decoder.decode(jws)), typeof jws != "string")
    throw new JWSInvalid("Compact JWS must be a string or Uint8Array");
  const { 0: protectedHeader, 1: payload, 2: signature, length } = jws.split(".");
  if (length !== 3)
    throw new JWSInvalid("Invalid Compact JWS");
  return verifySignature({ payload, protected: protectedHeader, signature }, shared, key, encodeCompactUnencodedPayload);
}

// ../../node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/jws/compact/verify.js
async function compactVerify(jws, key, options) {
  const [result] = await verifyCompact(jws, prepareVerify(options), key);
  return result;
}

// ../../node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/jwks/local.js
function isUsableJWK(jwk, entry, alg, kid) {
  const { kty, key_ops: keyOps, ext, kid: jwkKid, alg: jwkAlg, use, crv } = jwk;
  return (ext === void 0 || typeof ext == "boolean") && (keyOps === void 0 || Array.isArray(keyOps) && keyOps.every((operation, index) => typeof operation == "string" && keyOps.indexOf(operation) === index) && keyOps.includes("verify")) && entry.kty.includes(kty) && (kid === void 0 || typeof kid == "string" && kid === jwkKid) && (jwkAlg === void 0 ? kty !== "AKP" : alg === jwkAlg) && (use === void 0 || use === "sig") && (!entry.crv || crv === entry.crv);
}
async function importWithAlgCache(cache2, jwk, entry) {
  const cached = cache2.get(jwk) || cache2.set(jwk, {}).get(jwk), { alg } = entry;
  if (cached[alg] === void 0) {
    const pending = jwkToKey(entry, jwk, true).then((key) => {
      if (key.type !== "public")
        throw new JWKSInvalid("JSON Web Key Set members must be public keys");
      return cached[alg] = key, key;
    }).catch((error) => {
      throw cached[alg] === pending && delete cached[alg], error;
    });
    cached[alg] = pending;
  }
  return cached[alg];
}
function createLocalJWKSet(jwks) {
  let snapshot;
  try {
    snapshot = structuredClone(jwks);
  } catch {
  }
  if (!isJwkSet(snapshot))
    throw new JWKSInvalid("JSON Web Key Set malformed");
  const metadata = snapshot.keys.map((jwk) => {
    const normalized = snapshotJwk(jwk);
    return Array.isArray(normalized.key_ops) && (normalized.key_ops = [...normalized.key_ops]), normalized;
  }), cached = /* @__PURE__ */ new WeakMap();
  return Object.defineProperty(async (protectedHeader, token) => {
    const { alg, kid } = { ...protectedHeader, ...token?.header }, entry = typeof alg == "string" ? JWS[alg] : void 0;
    if (!entry || entry.secret)
      throw new JOSENotSupported('Unsupported "alg" value for a JSON Web Key Set');
    const candidates = snapshot.keys.filter((_, index) => isUsableJWK(metadata[index], entry, alg, kid)), { 0: jwk, length } = candidates;
    if (!length)
      throw new JWKSNoMatchingKey();
    if (length !== 1) {
      const error = new JWKSMultipleMatchingKeys();
      throw error[Symbol.asyncIterator] = async function* () {
        for (const jwk2 of candidates)
          try {
            yield await importWithAlgCache(cached, jwk2, entry);
          } catch {
          }
      }, error;
    }
    return importWithAlgCache(cached, jwk, entry);
  }, "jwks", {
    value: () => structuredClone(snapshot)
  });
}

// ../sshsig/dist/index.js
var import_node_child_process = require("node:child_process");
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_node_util = require("node:util");
var execFileP = (0, import_node_util.promisify)(import_node_child_process.execFile);
var ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
var ARMOR_END = "-----END SSH SIGNATURE-----";
function base64ToArmor(b64) {
  const lines = b64.match(/.{1,70}/g) ?? [];
  return `${ARMOR_BEGIN}
${lines.join("\n")}
${ARMOR_END}
`;
}
function runWithStdin(cmd, argv, stdin) {
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process.spawn)(cmd, argv, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1 }));
    child.stdin.end(Buffer.from(stdin));
  });
}
async function verifySshSignature(args) {
  const dir = await (0, import_promises.mkdtemp)((0, import_node_path.join)((0, import_node_os.tmpdir)(), "thwip-verify-"));
  try {
    const allowedSigners = (0, import_node_path.join)(dir, "allowed_signers");
    const sigPath = (0, import_node_path.join)(dir, "sig");
    const [keyType, keyBlob] = args.publicKey.trim().split(/\s+/);
    if (!keyType || !keyBlob)
      throw new Error("invalid public key");
    await (0, import_promises.writeFile)(allowedSigners, `thwip namespaces="${args.namespace}" ${keyType} ${keyBlob}
`);
    await (0, import_promises.writeFile)(sigPath, base64ToArmor(args.signatureBase64));
    const { code } = await runWithStdin("ssh-keygen", ["-Y", "verify", "-f", allowedSigners, "-I", "thwip", "-n", args.namespace, "-s", sigPath], args.message);
    return code === 0;
  } finally {
    await (0, import_promises.rm)(dir, { recursive: true, force: true });
  }
}

// ../protocol/dist/types.js
var STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
var PREDICATE_TYPE = "urn:thwip:attestation:ci-run:v1";
var DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
var SSH_SIGN_NAMESPACE = "thwip-ci-dsse-v1";
var TRAILER_KEY = "thwip-proof";
var LEASE_AUDIENCE = "urn:thwip:ci-run:v1";
var CARRIER_VERSION = "v1";
var CARRIER_MAX_ENCODED = 32 * 1024;
var ENVELOPE_MAX_DECODED = 24 * 1024;

// ../protocol/dist/encoding.js
var B64URL_RE = /^[A-Za-z0-9_-]+$/;
var B64STD_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function b64urlDecode(s) {
  if (s.length === 0 || !B64URL_RE.test(s))
    throw new Error("invalid base64url");
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - std.length % 4);
  const bin = atob(std + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
function b64stdDecode(s) {
  if (s.length === 0 || !B64STD_RE.test(s))
    throw new Error("invalid base64");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
function utf8Encode(s) {
  return new TextEncoder().encode(s);
}
function utf8Decode(b) {
  return new TextDecoder("utf-8", { fatal: true }).decode(b);
}

// ../protocol/dist/pae.js
function dssePae(payloadType, payload) {
  const typeBytes = utf8Encode(payloadType);
  const header = utf8Encode(`DSSEv1 ${typeBytes.length} ${payloadType} ${payload.length} `);
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

// ../protocol/dist/schema.js
var DECIMAL_RE = /^[0-9]+$/;
var OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
var SHA256_RE = /^sha256:[0-9a-f]{64}$/;
var SUITE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function fail(detail) {
  return { ok: false, detail };
}
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v, name, max = 4096) {
  if (typeof v !== "string" || v.length === 0 || v.length > max)
    return fail(`${name} invalid`);
  return { ok: true, value: v };
}
function parseEnvelope(v) {
  if (!isRecord(v))
    return fail("envelope not an object");
  if (v["payloadType"] !== DSSE_PAYLOAD_TYPE)
    return fail("payloadType unsupported");
  const payload = str(v["payload"], "payload", 32768);
  if (!payload.ok)
    return payload;
  const sigs = v["signatures"];
  if (!Array.isArray(sigs) || sigs.length !== 1)
    return fail("signatures must contain exactly one entry");
  const s0 = sigs[0];
  if (!isRecord(s0))
    return fail("signature not an object");
  const keyid = str(s0["keyid"], "keyid", 256);
  if (!keyid.ok)
    return keyid;
  const sig2 = str(s0["sig"], "sig", 8192);
  if (!sig2.ok)
    return sig2;
  return {
    ok: true,
    value: {
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: payload.value,
      signatures: [{ keyid: keyid.value, sig: sig2.value }]
    }
  };
}
function parseSuite(v, i) {
  if (!isRecord(v))
    return fail(`suite[${i}] not an object`);
  const id2 = v["id"];
  if (typeof id2 !== "string" || !SUITE_ID_RE.test(id2))
    return fail(`suite[${i}].id invalid`);
  const status = v["status"];
  if (status !== "passed" && status !== "failed" && status !== "skipped")
    return fail(`suite[${i}].status invalid`);
  const durationMs = v["durationMs"];
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return fail(`suite[${i}].durationMs invalid`);
  }
  const out = { id: id2, status, durationMs };
  if (v["reportDigest"] !== void 0) {
    if (typeof v["reportDigest"] !== "string" || !SHA256_RE.test(v["reportDigest"])) {
      return fail(`suite[${i}].reportDigest invalid`);
    }
    out.reportDigest = v["reportDigest"];
  }
  return { ok: true, value: out };
}
function parseStatement(v) {
  if (!isRecord(v))
    return fail("statement not an object");
  if (v["_type"] !== STATEMENT_TYPE)
    return fail("statement _type unsupported");
  if (v["predicateType"] !== PREDICATE_TYPE)
    return fail("predicateType unsupported");
  const subject = v["subject"];
  if (!Array.isArray(subject) || subject.length !== 1)
    return fail("subject must contain exactly one entry");
  const sub0 = subject[0];
  if (!isRecord(sub0) || sub0["name"] !== "git-tree" || !isRecord(sub0["digest"]))
    return fail("subject invalid");
  const digest = {};
  for (const [k, val] of Object.entries(sub0["digest"])) {
    if (k !== "sha1" && k !== "sha256")
      return fail("subject digest algorithm unsupported");
    if (typeof val !== "string" || !OID_RE.test(val))
      return fail("subject digest value invalid");
    digest[k] = val;
  }
  if (digest.sha1 === void 0 && digest.sha256 === void 0)
    return fail("subject digest empty");
  const pred = parsePredicate(v["predicate"]);
  if (!pred.ok)
    return pred;
  return {
    ok: true,
    value: {
      _type: STATEMENT_TYPE,
      subject: [{ name: "git-tree", digest }],
      predicateType: PREDICATE_TYPE,
      predicate: pred.value
    }
  };
}
function parsePredicate(v) {
  if (!isRecord(v))
    return fail("predicate not an object");
  if (v["schemaVersion"] !== "1")
    return fail("predicate schemaVersion unsupported");
  const repo = v["repository"];
  if (!isRecord(repo) || repo["provider"] !== "github")
    return fail("repository invalid");
  const ownerId = repo["ownerId"];
  const repositoryId = repo["repositoryId"];
  if (typeof ownerId !== "string" || !DECIMAL_RE.test(ownerId))
    return fail("repository.ownerId invalid");
  if (typeof repositoryId !== "string" || !DECIMAL_RE.test(repositoryId))
    return fail("repository.repositoryId invalid");
  const git = v["git"];
  if (!isRecord(git))
    return fail("git invalid");
  const objectFormat = git["objectFormat"];
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
    return fail("git.objectFormat invalid");
  const treeOid = git["treeOid"];
  if (typeof treeOid !== "string" || !OID_RE.test(treeOid))
    return fail("git.treeOid invalid");
  const parentOids = git["parentOids"];
  if (!Array.isArray(parentOids) || parentOids.length > 16)
    return fail("git.parentOids invalid");
  for (const p of parentOids)
    if (typeof p !== "string" || !OID_RE.test(p))
      return fail("git.parentOids entry invalid");
  const baseRef = str(git["baseRef"], "git.baseRef", 512);
  if (!baseRef.ok)
    return baseRef;
  const baseSha = git["baseSha"];
  if (typeof baseSha !== "string" || !OID_RE.test(baseSha))
    return fail("git.baseSha invalid");
  const evaluationMode = git["evaluationMode"];
  if (evaluationMode !== "head-tree")
    return fail("git.evaluationMode invalid");
  const policy = v["policy"];
  if (!isRecord(policy))
    return fail("policy invalid");
  const policyDigest = policy["digest"];
  if (typeof policyDigest !== "string" || !SHA256_RE.test(policyDigest))
    return fail("policy.digest invalid");
  const policyVersion = policy["version"];
  if (typeof policyVersion !== "number" || !Number.isInteger(policyVersion) || policyVersion < 1) {
    return fail("policy.version invalid");
  }
  const pipeline = v["pipeline"];
  if (!isRecord(pipeline))
    return fail("pipeline invalid");
  const pipelineDigest = pipeline["digest"];
  if (typeof pipelineDigest !== "string" || !SHA256_RE.test(pipelineDigest))
    return fail("pipeline.digest invalid");
  const runner = pipeline["runner"];
  if (runner !== "dagger" && runner !== "command")
    return fail("pipeline.runner invalid");
  const run = v["run"];
  if (!isRecord(run))
    return fail("run invalid");
  const startedAt = str(run["startedAt"], "run.startedAt", 64);
  if (!startedAt.ok)
    return startedAt;
  const finishedAt = str(run["finishedAt"], "run.finishedAt", 64);
  if (!finishedAt.ok)
    return finishedAt;
  let lease;
  if (run["lease"] !== void 0) {
    const l = str(run["lease"], "run.lease", 8192);
    if (!l.ok)
      return l;
    lease = l.value;
  }
  const networkMode = run["networkMode"];
  if (networkMode !== "disabled" && networkMode !== "restricted" && networkMode !== "unrestricted") {
    return fail("run.networkMode invalid");
  }
  const cacheMode = run["cacheMode"];
  if (cacheMode !== "disabled" && cacheMode !== "read-only" && cacheMode !== "read-write") {
    return fail("run.cacheMode invalid");
  }
  const suitesRaw = run["suites"];
  if (!Array.isArray(suitesRaw) || suitesRaw.length === 0 || suitesRaw.length > 64)
    return fail("run.suites invalid");
  const suites = [];
  for (let i = 0; i < suitesRaw.length; i++) {
    const s = parseSuite(suitesRaw[i], i);
    if (!s.ok)
      return s;
    suites.push(s.value);
  }
  const signer = v["signer"];
  if (!isRecord(signer))
    return fail("signer invalid");
  const keyId = str(signer["keyId"], "signer.keyId", 256);
  if (!keyId.ok)
    return keyId;
  const githubUserId = signer["githubUserId"];
  if (typeof githubUserId !== "string" || !DECIMAL_RE.test(githubUserId))
    return fail("signer.githubUserId invalid");
  const predicate = {
    schemaVersion: "1",
    repository: { provider: "github", ownerId, repositoryId },
    git: {
      objectFormat,
      treeOid,
      parentOids,
      baseRef: baseRef.value,
      baseSha,
      evaluationMode
    },
    policy: { digest: policyDigest, version: policyVersion },
    pipeline: { digest: pipelineDigest, runner },
    run: {
      startedAt: startedAt.value,
      finishedAt: finishedAt.value,
      ...lease !== void 0 ? { lease } : {},
      networkMode,
      cacheMode,
      suites
    },
    signer: { keyId: keyId.value, githubUserId }
  };
  return { ok: true, value: predicate };
}

// ../protocol/dist/carrier.js
function extractCarrier(commitMessage) {
  const lines = commitMessage.split("\n");
  const matches = [];
  for (const line of lines) {
    if (line.startsWith(`${TRAILER_KEY}:`)) {
      matches.push(line.slice(TRAILER_KEY.length + 1).trim());
    }
  }
  if (matches.length === 0)
    return { ok: false, error: { code: "PROOF_MISSING" } };
  if (matches.length > 1)
    return { ok: false, error: { code: "PROOF_DUPLICATE" } };
  const value = matches[0];
  if (value.length > CARRIER_MAX_ENCODED)
    return { ok: false, error: { code: "PROOF_TOO_LARGE" } };
  const dot = value.indexOf(".");
  if (dot < 0)
    return { ok: false, error: { code: "PROOF_MALFORMED", detail: "missing version separator" } };
  const version = value.slice(0, dot);
  if (version !== CARRIER_VERSION) {
    return { ok: false, error: { code: "PROOF_SCHEMA_UNSUPPORTED", detail: `carrier version ${version}` } };
  }
  let bytes;
  try {
    bytes = b64urlDecode(value.slice(dot + 1));
  } catch {
    return { ok: false, error: { code: "PROOF_MALFORMED", detail: "invalid base64url" } };
  }
  if (bytes.length > ENVELOPE_MAX_DECODED)
    return { ok: false, error: { code: "PROOF_TOO_LARGE" } };
  let json;
  try {
    json = JSON.parse(utf8Decode(bytes));
  } catch {
    return { ok: false, error: { code: "PROOF_MALFORMED", detail: "invalid JSON envelope" } };
  }
  const parsed = parseEnvelope(json);
  if (!parsed.ok)
    return { ok: false, error: { code: "PROOF_MALFORMED", detail: parsed.detail } };
  return { ok: true, envelope: parsed.value, envelopeRawBytes: bytes };
}

// ../protocol/dist/digest.js
var import_canonicalize = __toESM(require_canonicalize(), 1);

// ../verifier/dist/remote-suite-settlement.js
var SETTLEMENT_ATTEMPTS = 3;
var SETTLEMENT_DELAYS_MS = [1e3, 2e3, 4e3];
var NOT_CONCLUDED = /* @__PURE__ */ new Set(["pending", "queued", "in_progress", "waiting", "requested", "none", ""]);
var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settleRemoteSuites(suiteIds, reads, options = {}) {
  const attempts = options.attempts ?? SETTLEMENT_ATTEMPTS;
  const delays = options.delaysMs ?? SETTLEMENT_DELAYS_MS;
  const sleep = options.sleep ?? wait;
  let agreed = 0;
  let agreedNegative = null;
  let unsettled = "no read of GitHub's checks was attempted";
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0)
      await sleep(delays[Math.min(i - 1, delays.length - 1)] ?? 1e3);
    const conclusions = await reads.readConclusions();
    if (conclusions === null) {
      unsettled = "GitHub did not answer when asked which checks ran on this commit; thwip reads again and decides then";
      continue;
    }
    let waiting = null;
    let negative = null;
    for (const suiteId of suiteIds) {
      const conclusion = conclusions.get(suiteId) ?? conclusions.get(`thwip / ${suiteId}`);
      if (conclusion === void 0) {
        waiting ??= `\`${suiteId}\` has no check on this commit yet; thwip verifies the proof once GitHub reports one`;
        continue;
      }
      if (conclusion === "success")
        continue;
      if (NOT_CONCLUDED.has(conclusion)) {
        waiting ??= `GitHub is still running \`${suiteId}\` on this commit; thwip verifies the proof once that check reports`;
        continue;
      }
      negative ??= { suiteId, conclusion };
    }
    if (negative === null && waiting === null)
      return { kind: "passed" };
    if (negative === null) {
      agreed = 0;
      agreedNegative = null;
      unsettled = waiting;
      continue;
    }
    if (agreedNegative !== null && agreedNegative.suiteId === negative.suiteId && agreedNegative.conclusion === negative.conclusion) {
      agreed += 1;
    } else {
      agreedNegative = negative;
      agreed = 1;
    }
    unsettled = `GitHub's reads disagree about \`${negative.suiteId}\`; thwip reads again and decides then`;
  }
  if (agreedNegative !== null && agreed === attempts) {
    return {
      kind: "failed",
      suiteId: agreedNegative.suiteId,
      conclusion: agreedNegative.conclusion,
      reason: `GitHub's check for \`${agreedNegative.suiteId}\` concluded ${agreedNegative.conclusion} on this commit, and ${attempts} reads agree; fix that check and push again`
    };
  }
  return { kind: "unsettled", reason: unsettled };
}

// ../verifier/dist/lease-signature.js
var ALGORITHMS = {
  ES256: {
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
    kty: "EC"
  },
  EdDSA: {
    importParams: { name: "Ed25519" },
    verifyParams: { name: "Ed25519" },
    kty: "OKP"
  }
};
async function verifyLeaseSignature(args) {
  const spec = ALGORITHMS[args.algorithm];
  if (spec === void 0)
    return false;
  const jwk = args.jwk;
  if (typeof jwk !== "object" || jwk === null || jwk.kty !== spec.kty)
    return false;
  if (typeof jwk.alg === "string" && jwk.alg !== args.algorithm)
    return false;
  try {
    const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["verify"], ext: true }, spec.importParams, false, [
      "verify"
    ]);
    return await crypto.subtle.verify(spec.verifyParams, key, args.signature, args.signingInput);
  } catch {
    return false;
  }
}

// ../verifier/dist/ssh-signature.js
function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
var Reader = class {
  buf;
  off = 0;
  constructor(buf) {
    this.buf = buf;
  }
  u32() {
    if (this.off + 4 > this.buf.length)
      throw new Error("truncated");
    const v = this.buf[this.off] << 24 | this.buf[this.off + 1] << 16 | this.buf[this.off + 2] << 8 | this.buf[this.off + 3];
    this.off += 4;
    return v >>> 0;
  }
  bytes(n) {
    if (this.off + n > this.buf.length)
      throw new Error("truncated");
    const v = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return v;
  }
  string() {
    return this.bytes(this.u32());
  }
};
function encodeSshString(b) {
  const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length);
  out.set(b, 4);
  return out;
}
function concat2(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
var te = new TextEncoder();
var td = new TextDecoder();
function ed25519RawFromAuthorizedKey(publicKey) {
  const parts = publicKey.trim().split(/\s+/);
  if (parts[0] !== "ssh-ed25519" || !parts[1])
    throw new Error("not an ssh-ed25519 key");
  const blob = b64decode(parts[1]);
  const r = new Reader(blob);
  const keyType = td.decode(r.string());
  if (keyType !== "ssh-ed25519")
    throw new Error("key blob type mismatch");
  const raw = r.string();
  if (raw.length !== 32)
    throw new Error("bad ed25519 key length");
  return raw;
}
async function verifySshSignature2(args) {
  try {
    const raw = ed25519RawFromAuthorizedKey(args.publicKey);
    const blob = b64decode(args.signatureBase64);
    const r = new Reader(blob);
    if (td.decode(r.bytes(6)) !== "SSHSIG")
      return false;
    if (r.u32() !== 1)
      return false;
    const sigPubBlob = r.string();
    const namespace = r.string();
    if (td.decode(namespace) !== args.namespace)
      return false;
    const reserved = r.string();
    const hashAlg = r.string();
    const hashAlgName = td.decode(hashAlg);
    if (hashAlgName !== "sha512" && hashAlgName !== "sha256")
      return false;
    const sigBlob = r.string();
    const pr = new Reader(sigPubBlob);
    if (td.decode(pr.string()) !== "ssh-ed25519")
      return false;
    const sigPubRaw = pr.string();
    if (sigPubRaw.length !== raw.length || sigPubRaw.some((b, i) => b !== raw[i]))
      return false;
    const sr = new Reader(sigBlob);
    if (td.decode(sr.string()) !== "ssh-ed25519")
      return false;
    const rawSig = sr.string();
    if (rawSig.length !== 64)
      return false;
    const hashed = new Uint8Array(await crypto.subtle.digest(hashAlgName === "sha512" ? "SHA-512" : "SHA-256", args.message));
    const signedData = concat2(te.encode("SSHSIG"), encodeSshString(te.encode(args.namespace)), encodeSshString(reserved), encodeSshString(hashAlg), encodeSshString(hashed));
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, rawSig, signedData);
  } catch {
    return false;
  }
}

// ../verifier/dist/index.js
var PERMISSION_RANK = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5
};
function res(code, detail, extra) {
  return { code, ...detail !== void 0 ? { detail } : {}, ...extra };
}
async function verifyProof(input, deps) {
  const { facts, bundle } = input;
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) {
    return res("BUNDLE_UNAVAILABLE", "the verifier was given a clock reading it cannot parse; pass an ISO-8601 timestamp as `now`");
  }
  const bundleExpiry = Date.parse(bundle.expiresAt);
  if (!Number.isFinite(bundleExpiry)) {
    return res("BUNDLE_UNAVAILABLE", "the bundle carries an expiry this verifier cannot read, so its freshness cannot be judged");
  }
  if (bundleExpiry < nowMs)
    return res("BUNDLE_EXPIRED");
  const carrier = extractCarrier(input.commitMessage);
  if (!carrier.ok) {
    const e = carrier.error;
    return res(e.code, "detail" in e ? e.detail : void 0);
  }
  const envelope = carrier.envelope;
  let payloadBytes;
  try {
    payloadBytes = b64stdDecode(envelope.payload);
  } catch {
    return res("PROOF_MALFORMED", "payload not base64");
  }
  const keyid = envelope.signatures[0].keyid;
  const key = bundle.keys.find((k) => k.keyId === keyid);
  if (!key)
    return res("SIGNER_KEY_UNKNOWN", keyid);
  if (key.revokedAt !== null)
    return res("SIGNER_KEY_REVOKED", keyid);
  if (!bundle.policy.allowedKeyAlgorithms.includes(key.algorithm)) {
    return res("SIGNER_KEY_ALGORITHM_FORBIDDEN", key.algorithm);
  }
  const pae = dssePae(DSSE_PAYLOAD_TYPE, payloadBytes);
  let sigOk;
  const checkSshSignature = deps.verifySshSignature ?? verifySshSignature2;
  try {
    sigOk = await checkSshSignature({
      publicKey: key.publicKey,
      namespace: SSH_SIGN_NAMESPACE,
      message: pae,
      signatureBase64: envelope.signatures[0].sig
    });
  } catch {
    sigOk = false;
  }
  if (!sigOk)
    return res("SIGNATURE_INVALID");
  let statementJson;
  try {
    statementJson = JSON.parse(utf8Decode(payloadBytes));
  } catch {
    return res("PROOF_MALFORMED", "payload not JSON");
  }
  const parsed = parseStatement(statementJson);
  if (!parsed.ok)
    return res("PROOF_MALFORMED", parsed.detail);
  const statement = parsed.value;
  const pred = statement.predicate;
  if (pred.repository.ownerId !== facts.ownerId || pred.repository.repositoryId !== facts.repositoryId) {
    return res("SUBJECT_REPOSITORY_MISMATCH", void 0, { statement });
  }
  if (bundle.repositoryId !== facts.repositoryId || bundle.ownerId !== facts.ownerId) {
    return res("SUBJECT_REPOSITORY_MISMATCH", "bundle/facts repository disagreement", { statement });
  }
  if (pred.git.objectFormat !== facts.objectFormat)
    return res("SUBJECT_TREE_MISMATCH", "object format", { statement });
  const subjectDigest = statement.subject[0].digest[facts.objectFormat];
  if (subjectDigest !== facts.treeOid || pred.git.treeOid !== facts.treeOid) {
    return res("SUBJECT_TREE_MISMATCH", void 0, { statement });
  }
  const declaredParents = pred.git.parentOids;
  if (declaredParents.length !== facts.parentOids.length || declaredParents.some((p, i) => p !== facts.parentOids[i])) {
    return res("SUBJECT_ANCESTRY_MISMATCH", void 0, { statement });
  }
  if (pred.git.baseSha !== facts.baseSha)
    return res("SUBJECT_BASE_MISMATCH", void 0, { statement });
  if (pred.pipeline.digest !== bundle.policy.pipeline.digest || pred.pipeline.runner !== bundle.policy.pipeline.runner) {
    return res("PIPELINE_DIGEST_MISMATCH", `this project now runs pipeline ${bundle.policy.pipeline.digest} on ${bundle.policy.pipeline.runner} and the proof ran ${pred.pipeline.digest} on ${pred.pipeline.runner}; run \`thwip run\` again`, { statement });
  }
  if (pred.signer.keyId !== keyid)
    return res("SIGNER_MISMATCH", "predicate keyId != envelope keyid", { statement });
  if (pred.signer.githubUserId !== key.githubUserId) {
    return res("SIGNER_MISMATCH", "predicate user != enrolled key user", { statement });
  }
  const grant = bundle.grants.find((g) => g.githubUserId === key.githubUserId);
  if (!grant || !grant.active)
    return res("SIGNER_PERMISSION_INSUFFICIENT", "no active grant", { statement });
  const need = PERMISSION_RANK[bundle.policy.minimumPermission] ?? 99;
  if ((PERMISSION_RANK[grant.permission] ?? 0) < need) {
    return res("SIGNER_PERMISSION_INSUFFICIENT", grant.permission, { statement });
  }
  if (!bundle.policy.allowAuthorAsSigner) {
    if (facts.prAuthorGithubUserId === void 0) {
      return res("SIGNER_PERMISSION_INSUFFICIENT", "this project requires somebody other than the author to sign, and the checker could not find out who opened the pull request for this commit; re-run the check, and if it persists ask an administrator to check the GitHub App's pull request permission", { statement });
    }
    if (facts.prAuthorGithubUserId === key.githubUserId) {
      return res("SIGNER_PERMISSION_INSUFFICIENT", "author may not sign", { statement });
    }
  }
  const seen = /* @__PURE__ */ new Set();
  for (const s of pred.run.suites) {
    if (seen.has(s.id))
      return res("SUITE_DUPLICATE", s.id, { statement });
    seen.add(s.id);
  }
  for (const required of bundle.policy.pipeline.requiredSuites) {
    const suite = pred.run.suites.find((s) => s.id === required);
    if (!suite) {
      return res("SUITE_MISSING", `this project requires ${required} and the proof does not report it; run \`thwip run\` again`, { statement });
    }
    if (suite.status !== "passed") {
      return res("SUITE_NOT_PASSED", `${required} is ${suite.status} in this proof`, { statement });
    }
  }
  const remoteSuites = bundle.policy.pipeline.remoteSuites ?? [];
  if (remoteSuites.length > 0) {
    const read = deps.remoteCheckConclusions;
    if (!read) {
      return res("SUITE_MISSING", "remote suites declared but no check reader available", { statement });
    }
    const settlement = await settleRemoteSuites(remoteSuites, {
      readConclusions: async () => {
        try {
          return await read(facts.headSha);
        } catch {
          return null;
        }
      }
    }, deps.sleep !== void 0 ? { sleep: deps.sleep } : {});
    if (settlement.kind === "failed")
      return res("SUITE_NOT_PASSED", settlement.reason, { statement });
    if (settlement.kind === "unsettled")
      return res("VERIFICATION_PENDING", settlement.reason, { statement });
  }
  const started = Date.parse(pred.run.startedAt);
  const finished = Date.parse(pred.run.finishedAt);
  if (!Number.isFinite(finished))
    return res("PROOF_MALFORMED", "finishedAt unparseable", { statement });
  if (!Number.isFinite(started))
    return res("PROOF_MALFORMED", "startedAt unparseable", { statement });
  if (finished < started) {
    return res("PROOF_MALFORMED", `the proof says the run finished at ${pred.run.finishedAt}, before it started at ${pred.run.startedAt}; check the clock on the machine that ran the tests and sign again`, { statement });
  }
  if (finished > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
    return res("PROOF_MALFORMED", `the proof says the run finished at ${pred.run.finishedAt}, which is in the future; check the clock on the machine that ran the tests and sign again`, { statement });
  }
  if (nowMs - finished > bundle.policy.proofMaxAgeSeconds * 1e3) {
    return res("PROOF_EXPIRED", void 0, { statement });
  }
  if (bundle.policy.lease.required) {
    const lease = pred.run.lease;
    if (lease === void 0) {
      return res("LEASE_REQUIRED", "this project requires a run lease and the proof carries none; run `thwip run` so the tests execute inside a lease", { statement });
    }
    const verdict = await checkLease({ lease, bundle, facts, pred, nowMs, deps });
    if (verdict !== void 0)
      return { ...verdict, statement };
  }
  return res("PASS", void 0, { statement, signerKey: key });
}
var CLOCK_SKEW_TOLERANCE_MS = 6e4;
var LEASE_ALGORITHMS = /* @__PURE__ */ new Set(["ES256", "EdDSA"]);
function b64urlDecode2(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return b64stdDecode(padded + "=".repeat((4 - padded.length % 4) % 4));
}
async function checkLease(input) {
  const { lease, bundle, facts, pred, nowMs, deps } = input;
  const jwks = bundle.leaseIssuerJwks;
  if (jwks.length === 0) {
    return res("LEASE_INVALID", "this project requires a run lease and carries no issuer keys to check one against; ask an administrator to reload the project's verification keys");
  }
  const checkSignature = deps.verifyLeaseSignature ?? verifyLeaseSignature;
  const parts = lease.split(".");
  if (parts.length !== 3)
    return res("LEASE_INVALID", "the lease in this proof is not a signed token; run `thwip run` again");
  let header;
  let claims;
  try {
    header = JSON.parse(utf8Decode(b64urlDecode2(parts[0])));
    claims = JSON.parse(utf8Decode(b64urlDecode2(parts[1])));
  } catch {
    return res("LEASE_INVALID", "the lease in this proof cannot be read; run `thwip run` again to get a fresh one");
  }
  const alg = typeof header.alg === "string" ? header.alg : "";
  if (!LEASE_ALGORITHMS.has(alg)) {
    return res("LEASE_INVALID", `the lease is signed with ${alg || "no algorithm"}, which this project does not accept`);
  }
  const signingInput = utf8Encode(`${parts[0]}.${parts[1]}`);
  let signature;
  try {
    signature = b64urlDecode2(parts[2]);
  } catch {
    return res("LEASE_INVALID", "the lease signature is not readable; run `thwip run` again to get a fresh lease");
  }
  const kid = typeof header.kid === "string" ? header.kid : void 0;
  const candidates = jwks.filter((jwk) => {
    if (kid === void 0)
      return true;
    const id2 = jwk?.kid;
    return typeof id2 !== "string" || id2 === kid;
  });
  let signatureOk = false;
  for (const jwk of candidates) {
    try {
      if (await checkSignature({ jwk, algorithm: alg, signingInput, signature })) {
        signatureOk = true;
        break;
      }
    } catch {
    }
  }
  if (!signatureOk) {
    return res("LEASE_INVALID", "the lease in this proof was not signed by this project's lease issuer; run `thwip run` again so thwip mints the lease");
  }
  const iat = typeof claims["iat"] === "number" ? claims["iat"] * 1e3 : void 0;
  if (iat === void 0) {
    return res("LEASE_INVALID", "the lease does not say when it was issued, so its age cannot be judged; run `thwip run` again");
  }
  const maxAgeMs = bundle.policy.lease.maxAgeSeconds * 1e3;
  if (nowMs - iat > maxAgeMs) {
    return res("LEASE_EXPIRED", `this project accepts leases up to ${bundle.policy.lease.maxAgeSeconds} seconds old and this one was issued at ${new Date(iat).toISOString()}; run the tests again`);
  }
  if (iat > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
    return res("LEASE_INVALID", "the lease says it was issued in the future; check the clock on this machine and run the tests again");
  }
  const exp = typeof claims["exp"] === "number" ? claims["exp"] * 1e3 : void 0;
  if (exp === void 0) {
    return res("LEASE_INVALID", "the lease does not say when it expires; run `thwip run` again to get one that does");
  }
  if (exp < nowMs) {
    return res("LEASE_EXPIRED", `the lease expired at ${new Date(exp).toISOString()}; run the tests again to open a new window`);
  }
  const nbf = typeof claims["nbf"] === "number" ? claims["nbf"] * 1e3 : void 0;
  if (nbf !== void 0 && nbf > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
    return res("LEASE_EXPIRED", "the lease is not valid yet; check the clock on this machine and run the tests again");
  }
  const finished = Date.parse(pred.run.finishedAt);
  if (Number.isFinite(finished) && finished < iat - CLOCK_SKEW_TOLERANCE_MS) {
    return res("LEASE_CONTEXT_MISMATCH", `the run finished at ${pred.run.finishedAt}, before the lease was issued at ${new Date(iat).toISOString()}; run the tests again inside the lease`);
  }
  const mismatch = (what, claimed, expected) => res("LEASE_CONTEXT_MISMATCH", `the lease was issued for ${what} ${String(claimed)} and this proof is for ${expected}; run the tests again on this branch`);
  if (claims["aud"] !== LEASE_AUDIENCE)
    return mismatch("audience", claims["aud"], LEASE_AUDIENCE);
  if (claims["repositoryId"] !== facts.repositoryId) {
    return mismatch("repository", claims["repositoryId"], facts.repositoryId);
  }
  if (claims["projectId"] !== bundle.projectId) {
    return mismatch("project incarnation", claims["projectId"], bundle.projectId);
  }
  if (claims["treeOid"] !== facts.treeOid)
    return mismatch("tree", claims["treeOid"], facts.treeOid);
  if (claims["baseSha"] !== null && claims["baseSha"] !== void 0 && claims["baseSha"] !== facts.baseSha) {
    return mismatch("base", claims["baseSha"], facts.baseSha);
  }
  const leaseParents = claims["parentOids"];
  if (Array.isArray(leaseParents) && leaseParents.length > 0 && (leaseParents.length !== facts.parentOids.length || leaseParents.some((p, i) => p !== facts.parentOids[i]))) {
    return mismatch("parents", leaseParents.join(","), facts.parentOids.join(","));
  }
  if (claims["policyDigest"] !== void 0 && claims["policyDigest"] !== pred.policy.digest) {
    return mismatch("policy", claims["policyDigest"], pred.policy.digest);
  }
  if (claims["deviceKeyId"] !== void 0 && claims["deviceKeyId"] !== pred.signer.keyId) {
    return mismatch("device key", claims["deviceKeyId"], pred.signer.keyId);
  }
  return void 0;
}

// src/bundle-resolution.ts
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseBundleResolutionBody(value) {
  if (!record(value)) throw new Error("BUNDLE_UNAVAILABLE: resolver returned a non-object");
  if (value["state"] === "bootstrap_pending") {
    if (value["code"] !== "POLICY_AWAITING_FIRST_MERGE" || typeof value["repository"] !== "string" || typeof value["repositoryId"] !== "string" || typeof value["projectId"] !== "string" || typeof value["defaultBranch"] !== "string") {
      throw new Error("BUNDLE_UNAVAILABLE: malformed bootstrap state");
    }
    return {
      kind: "bootstrap_pending",
      code: value["code"],
      repository: value["repository"],
      repositoryId: value["repositoryId"],
      projectId: value["projectId"],
      defaultBranch: value["defaultBranch"]
    };
  }
  if (value["state"] === "active" && typeof value["bundle"] === "string") {
    return { kind: "active", bundle: value["bundle"] };
  }
  throw new Error("BUNDLE_UNAVAILABLE: resolver returned neither an active bundle nor bootstrap state");
}

// src/control-plane.ts
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function bodyText(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}
function verificationKey(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const key = value;
  return key["kty"] === "EC" && key["crv"] === "P-256" && key["alg"] === "ES256" && key["use"] === "sig" && typeof key["kid"] === "string" && key["kid"].length > 0 && typeof key["x"] === "string" && key["x"].length > 0 && typeof key["y"] === "string" && key["y"].length > 0;
}
function parsePublishedKeys(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = value["keys"];
  if (!Array.isArray(keys)) return null;
  const usable = keys.filter(verificationKey);
  return usable.length === 0 ? null : { keys: usable };
}
var ActionClient = class {
  #endpoint;
  #githubApiUrl;
  #githubToken;
  #env;
  #fetch;
  #sleep;
  #log;
  #oidcToken;
  constructor(options) {
    this.#endpoint = options.endpoint;
    this.#githubApiUrl = options.githubApiUrl;
    this.#githubToken = options.githubToken;
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? delay;
    this.#log = options.log ?? console.log;
  }
  async github(path, init = {}) {
    if (this.#githubToken === "") throw new Error("github-token is required for pull-request verification");
    const response = await this.#fetch(`${this.#githubApiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#githubToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "thwip-action",
        ...init.headers
      }
    });
    if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
    return response.json();
  }
  async controlPlane(path, body) {
    const response = await this.#fetch(`${this.#endpoint}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.#getOidcToken()}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let parsed = text;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed, text };
  }
  async publishedKeys() {
    const response = await this.#fetch(`${this.#endpoint}/.well-known/thwip-keys`, {
      headers: { accept: "application/json", "user-agent": "thwip-action" }
    });
    if (!response.ok) throw new Error(`SIGNING_KEYS_UNAVAILABLE: ${response.status}`);
    const keys = parsePublishedKeys(await response.json().catch(() => null));
    if (keys === null) throw new Error("SIGNING_KEYS_UNAVAILABLE: no usable ES256 signing key was published");
    return keys;
  }
  async authorize(input) {
    const body = {
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.headSha,
      baseRef: input.baseRef,
      authorGithubUserId: input.authorGithubUserId,
      draft: input.draft
    };
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await this.controlPlane(
        `/v1/queue/${input.repositoryId}/authorize`,
        body
      );
      if (response.status === 200) {
        const reason = response.body["reason"];
        return typeof reason === "string" ? reason : "UNKNOWN";
      }
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 6) {
        throw new Error(`queue authorization returned ${response.status}: ${bodyText(response.body)}`);
      }
      const wait2 = attempt * 15e3;
      this.#log(`Thwip Queue returned ${response.status}; retrying in ${wait2 / 1e3}s`);
      await this.#sleep(wait2);
    }
    throw new Error("queue authorization did not complete");
  }
  async reportCandidate(input) {
    if (input.actualWorkflowSha !== input.expectedWorkflowSha) {
      throw new Error("the verifier did not start from the dispatched workflow commit");
    }
    const response = await this.controlPlane(`/v1/queue/${input.repositoryId}/candidate-result`, {
      dispatchNonce: input.dispatchNonce
    });
    if (response.status !== 202) {
      throw new Error(`candidate report returned ${response.status}: ${bodyText(response.body)}`);
    }
  }
  async #getOidcToken() {
    this.#oidcToken ??= this.#requestOidcToken();
    return this.#oidcToken;
  }
  async #requestOidcToken() {
    const requestUrl = this.#env["ACTIONS_ID_TOKEN_REQUEST_URL"];
    const requestToken = this.#env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
    if (!requestUrl || !requestToken) throw new Error("OIDC is unavailable; grant id-token: write");
    const url = new URL(requestUrl);
    url.searchParams.set("audience", `${this.#endpoint}/api/github-actions`);
    const response = await this.#fetch(url, {
      headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" }
    });
    if (!response.ok) throw new Error(`OIDC token request returned ${response.status}`);
    const body = await response.json();
    if (typeof body.value !== "string" || body.value === "") {
      throw new Error("OIDC token response contained no token");
    }
    return body.value;
  }
};

// src/context.ts
var import_node_fs = require("node:fs");
var DEFAULT_ENDPOINT = "https://thwip.ai";
function record2(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is missing or malformed`);
  }
  return value;
}
function string(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is missing or malformed`);
  return value;
}
function id(value, name) {
  if (typeof value !== "string" && typeof value !== "number" || String(value).length === 0) {
    throw new Error(`${name} is missing or malformed`);
  }
  return String(value);
}
function pullRequestContext(event, env) {
  const repository = record2(event["repository"], "repository");
  const owner = record2(repository["owner"], "repository.owner");
  const pullRequest = record2(event["pull_request"], "pull_request");
  const base = record2(pullRequest["base"], "pull_request.base");
  const head = record2(pullRequest["head"], "pull_request.head");
  const author = record2(pullRequest["user"], "pull_request.user");
  const number = pullRequest["number"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("pull_request.number is missing or malformed");
  }
  const draft = pullRequest["draft"];
  if (typeof draft !== "boolean") throw new Error("pull_request.draft is missing or malformed");
  return {
    kind: "pull_request",
    repositoryId: id(repository["id"], "repository.id"),
    repositoryOwnerId: id(owner["id"], "repository.owner.id"),
    repository: string(repository["full_name"], "repository.full_name"),
    pullRequestNumber: number,
    baseRefName: string(base["ref"], "pull_request.base.ref"),
    headSha: string(head["sha"], "pull_request.head.sha"),
    authorGithubUserId: id(author["id"], "pull_request.user.id"),
    draft,
    runId: env["GITHUB_RUN_ID"] ?? null
  };
}
function candidateReportContext(event, env) {
  if (event["action"] !== "thwip-queue-verify") {
    throw new Error(`unsupported repository_dispatch action ${String(event["action"] ?? "")}`);
  }
  const repository = record2(event["repository"], "repository");
  const payload = record2(event["client_payload"], "client_payload");
  return {
    kind: "candidate_report",
    repositoryId: id(repository["id"], "repository.id"),
    dispatchNonce: string(payload["dispatchNonce"], "client_payload.dispatchNonce"),
    expectedWorkflowSha: string(payload["workflowCommitSha"], "client_payload.workflowCommitSha"),
    actualWorkflowSha: string(env["GITHUB_WORKFLOW_SHA"], "GITHUB_WORKFLOW_SHA")
  };
}
function readActionContext(env = process.env) {
  const eventName = string(env["GITHUB_EVENT_NAME"], "GITHUB_EVENT_NAME");
  const eventPath = string(env["GITHUB_EVENT_PATH"], "GITHUB_EVENT_PATH");
  const event = record2(JSON.parse((0, import_node_fs.readFileSync)(eventPath, "utf8")), "event payload");
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return pullRequestContext(event, env);
  }
  if (eventName === "repository_dispatch") return candidateReportContext(event, env);
  throw new Error(`unsupported event ${eventName}`);
}
function readActionInputs(env = process.env) {
  const rawEndpoint = env["INPUT_ENDPOINT"]?.trim() || DEFAULT_ENDPOINT;
  const endpoint = new URL(rawEndpoint);
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "" || endpoint.pathname !== "/") {
    throw new Error("endpoint must be an HTTPS origin");
  }
  return {
    endpoint: endpoint.origin,
    githubToken: env["INPUT_GITHUB-TOKEN"]?.trim() ?? "",
    githubApiUrl: env["GITHUB_API_URL"]?.trim() || "https://api.github.com"
  };
}

// src/orchestration.ts
async function verifyAndAuthorize(verify, authorize, fail2, warn) {
  let exitCode = 1;
  try {
    exitCode = await verify();
  } catch (error) {
    fail2(error);
  }
  try {
    await authorize();
  } catch (error) {
    warn(error);
  }
  return exitCode;
}

// src/main.ts
function summary(line) {
  const f = process.env["GITHUB_STEP_SUMMARY"];
  if (f) (0, import_node_fs2.appendFileSync)(f, line + "\n");
  console.log(line);
}
function proofHints(commitMessage) {
  const carrier = extractCarrier(commitMessage);
  if (!carrier.ok) return {};
  const keyFingerprint = carrier.envelope.signatures[0]?.keyid;
  let signerGithubUserId;
  try {
    const statement = JSON.parse(new TextDecoder().decode(b64stdDecode(carrier.envelope.payload)));
    const claimed = statement.predicate?.signer?.githubUserId;
    if (typeof claimed === "string" && /^[0-9]+$/.test(claimed)) signerGithubUserId = claimed;
  } catch {
  }
  return {
    ...signerGithubUserId !== void 0 ? { signerGithubUserId } : {},
    ...keyFingerprint !== void 0 ? { keyFingerprint } : {}
  };
}
async function fetchBundle(client, repositoryId, headSha, hints) {
  const response = await client.controlPlane("/v1/verification-bundles:resolve", {
    repositoryId,
    headSha,
    ...hints
  });
  if (response.status !== 200) {
    throw new Error(`BUNDLE_UNAVAILABLE: ${response.status} ${response.text}`);
  }
  const resolution = parseBundleResolutionBody(response.body);
  if (resolution.kind === "bootstrap_pending") return resolution;
  const { payload, protectedHeader } = await compactVerify(
    resolution.bundle,
    createLocalJWKSet(await client.publishedKeys())
  );
  if (protectedHeader.alg !== "ES256" || protectedHeader.typ !== "thwip-bundle+jws") {
    throw new Error("BUNDLE_SIGNATURE_INVALID: bad protected header");
  }
  return {
    kind: "active",
    bundle: JSON.parse(new TextDecoder().decode(payload))
  };
}
async function mergeBase(client, repoFullName, base, head) {
  const cmp = await client.github(
    `/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${head}`
  );
  return cmp.merge_base_commit.sha;
}
async function requireBootstrapPrerequisites(client, fullName, ownerId, repositoryId, commit) {
  const carrier = extractCarrier(commit.message);
  if (!carrier.ok) {
    throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} has no parseable proof (${carrier.error.code})`);
  }
  let parsed;
  try {
    parsed = parseStatement(JSON.parse(utf8Decode(b64stdDecode(carrier.envelope.payload))));
  } catch {
    throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} has a malformed proof payload`);
  }
  if (!parsed.ok) {
    throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} proof payload ${parsed.detail}`);
  }
  const predicate = parsed.value.predicate;
  const objectFormat = commit.sha.length === 64 ? "sha256" : "sha1";
  if (predicate.repository.ownerId !== ownerId || predicate.repository.repositoryId !== repositoryId || predicate.git.treeOid !== commit.tree.sha || predicate.git.parentOids.length !== commit.parents.length || predicate.git.parentOids.some((parent, index) => parent !== commit.parents[index]?.sha) || parsed.value.subject[0]?.digest[objectFormat] !== commit.tree.sha) {
    throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} proof is not bound to this repository tree`);
  }
  try {
    await client.github(`/repos/${fullName}/contents/thwip.yaml?ref=${encodeURIComponent(commit.sha)}`);
  } catch {
    throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} has no committed thwip.yaml`);
  }
}
async function verifyPullRequest(context, client) {
  const commit = await client.github(`/repos/${context.repository}/git/commits/${context.headSha}`);
  const resolution = await fetchBundle(client, context.repositoryId, context.headSha, proofHints(commit.message));
  if (resolution.kind === "bootstrap_pending") {
    await requireBootstrapPrerequisites(
      client,
      context.repository,
      context.repositoryOwnerId,
      context.repositoryId,
      commit
    );
    summary("## \u{1F7E1} `BOOTSTRAP_PENDING` \u2014 waiting for the first canonical policy");
    summary("");
    summary(
      `${resolution.repository} is enabled, but has no active policy yet. This successful bootstrap result lets the onboarding change merge while the first canonical policy is derived.`
    );
    summary("");
    summary(
      `A candidate \`thwip.yaml\` and structured proof bound to the exact repository tree are present on the head. This result does **not** approve that candidate policy or verify its signature. After merge, thwip derives and activates the exact policy from \`${resolution.defaultBranch}\`; later changes are verified under the policy that was already active.`
    );
    await recordObservation(client, context.repositoryId, resolution.projectId, commit.sha, "BOOTSTRAP_PENDING", context.runId);
    return 0;
  }
  const bundle = resolution.bundle;
  const baseSha = await mergeBase(client, context.repository, context.baseRefName, context.headSha);
  const facts = {
    ownerId: context.repositoryOwnerId,
    repositoryId: context.repositoryId,
    headSha: commit.sha,
    treeOid: commit.tree.sha,
    parentOids: commit.parents.map((p) => p.sha),
    baseRef: `refs/heads/${context.baseRefName}`,
    baseSha,
    objectFormat: commit.sha.length === 64 ? "sha256" : "sha1",
    prAuthorGithubUserId: context.authorGithubUserId
  };
  const result = await verifyProof(
    { commitMessage: commit.message, facts, bundle, now: (/* @__PURE__ */ new Date()).toISOString() },
    {
      verifySshSignature,
      // Remote suites are proven by GitHub's own checks on this commit.
      remoteCheckConclusions: async (headSha) => {
        const runs = await client.github(
          `/repos/${context.repository}/commits/${headSha}/check-runs?per_page=100`
        );
        const map = /* @__PURE__ */ new Map();
        for (const r of runs.check_runs) map.set(r.name, r.conclusion ?? "pending");
        return map;
      }
    }
  );
  renderRichSummary(result, commit, facts);
  if (result.code === "VERIFICATION_PENDING") {
    console.log(
      `[thwip] ${commit.sha.slice(0, 12)}: waiting for evidence. ${result.detail ?? ""} Nothing failed. Re-run this job once the checks it names have finished.`
    );
  }
  if (result.code === "PASS" && result.statement) {
    await publishSuiteChecks(client, context.repository, commit.sha, result.statement).catch(() => {
    });
  }
  if (result.code !== "VERIFICATION_PENDING") {
    await recordObservation(client, context.repositoryId, bundle.projectId, commit.sha, result.code, context.runId);
  }
  return result.code === "PASS" ? 0 : 1;
}
async function recordObservation(client, repositoryId, projectId, headSha, outcome, runId) {
  try {
    await client.controlPlane("/v1/verification-observations", {
      repositoryId,
      projectId,
      headSha,
      outcome,
      runId
    });
  } catch {
  }
}
var CHECK_SEQUENCE = [
  ["Proof present on the exact head commit", ["PROOF_MISSING", "PROOF_DUPLICATE", "PROOF_TOO_LARGE", "PROOF_MALFORMED", "PROOF_SCHEMA_UNSUPPORTED"]],
  ["Signature by an enrolled, unrevoked key", ["SIGNATURE_INVALID", "SIGNER_KEY_UNKNOWN", "SIGNER_KEY_REVOKED", "SIGNER_KEY_ALGORITHM_FORBIDDEN"]],
  ["Repository identity matches GitHub", ["SUBJECT_REPOSITORY_MISMATCH"]],
  ["Exact Git tree matches", ["SUBJECT_TREE_MISMATCH"]],
  ["Ancestry (parents) matches", ["SUBJECT_ANCESTRY_MISMATCH"]],
  ["Base context matches", ["SUBJECT_BASE_MISMATCH"]],
  ["Pipeline digest is policy-approved", ["PIPELINE_DIGEST_MISMATCH"]],
  ["Signer holds current repository permission", ["SIGNER_MISMATCH", "SIGNER_PERMISSION_INSUFFICIENT"]],
  ["Every required suite passed exactly once", ["SUITE_MISSING", "SUITE_DUPLICATE", "SUITE_NOT_PASSED"]],
  ["Proof age and lease within policy", ["PROOF_EXPIRED", "LEASE_REQUIRED", "LEASE_INVALID", "LEASE_EXPIRED", "LEASE_CONTEXT_MISMATCH"]]
];
function renderRichSummary(result, commit, facts) {
  const pass = result.code === "PASS";
  const title = commit.message.split("\n")[0] ?? commit.sha;
  summary(`## ${pass ? "\u2705" : "\u274C"} \`${result.code}\` \u2014 ${title}`);
  summary("");
  summary(
    `commit \`${commit.sha.slice(0, 12)}\` \xB7 tree \`${facts.treeOid.slice(0, 12)}\` \xB7 base \`${facts.baseSha.slice(0, 12)}\`` + (result.signerKey ? ` \xB7 signer \`${result.signerKey.keyId}\` (${result.signerKey.algorithm})` : "")
  );
  summary("");
  const failedIndex = pass ? -1 : CHECK_SEQUENCE.findIndex(([, codes]) => codes.includes(result.code));
  summary("| Verified | Outcome |");
  summary("| --- | --- |");
  CHECK_SEQUENCE.forEach(([label], i) => {
    if (pass || failedIndex >= 0 && i < failedIndex) summary(`| ${label} | \u2705 |`);
    else if (i === failedIndex) summary(`| ${label} | \u274C \`${result.code}\`${result.detail ? ` (${result.detail})` : ""} |`);
    else if (failedIndex >= 0) summary(`| ${label} | \u23ED not reached |`);
    else summary(`| ${label} | \u274C \`${result.code}\` |`);
  });
  summary("");
  if (result.statement) {
    const run = result.statement.predicate.run;
    summary("### CI sequence proven");
    summary("");
    summary("| Suite | Result | Duration |");
    summary("| --- | --- | --- |");
    for (const s of run.suites) {
      const secs = (s.durationMs / 1e3).toFixed(1);
      summary(`| \`${s.id}\` | ${s.status === "passed" ? "\u2705 passed" : `\u274C ${s.status}`} | ${secs}s |`);
    }
    summary("");
    summary("```mermaid");
    summary("gantt");
    summary("  title local run \xB7 " + run.startedAt.slice(0, 19).replace("T", " ") + "Z");
    summary("  dateFormat  X");
    summary("  axisFormat  %Ss");
    summary("  section suites");
    let offset = 0;
    for (const s of run.suites) {
      const dur = Math.max(1, Math.round(s.durationMs / 1e3));
      summary(`  ${s.id} (${(s.durationMs / 1e3).toFixed(1)}s) :${s.status === "passed" ? "done" : "crit"}, ${offset}, ${offset + dur}`);
      offset += dur;
    }
    summary("```");
    summary("");
    summary(
      `_Suites ran on the signer's machine against the frozen tree; results are the signer's assertion, bound to this exact commit and the active policy, and verified here without rerunning them._`
    );
  }
}
async function publishSuiteChecks(client, fullName, headSha, statement) {
  const run = statement.predicate.run;
  let startMs = Date.parse(run.startedAt);
  for (const s of run.suites) {
    const started = new Date(startMs);
    const completed = new Date(startMs + s.durationMs);
    startMs += s.durationMs;
    await client.github(`/repos/${fullName}/check-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: `thwip / ${s.id}`,
        head_sha: headSha,
        status: "completed",
        conclusion: s.status === "passed" ? "success" : "failure",
        started_at: started.toISOString(),
        completed_at: completed.toISOString(),
        output: {
          title: `${s.id}: ${s.status} in ${(s.durationMs / 1e3).toFixed(1)}s on the signer's machine`,
          summary: `Proven by the thwip proof on \`${headSha.slice(0, 12)}\`: suite \`${s.id}\` ${s.status} in ${(s.durationMs / 1e3).toFixed(1)}s against the frozen tree. Verified cryptographically; not rerun here.`
        }
      })
    });
  }
}
function message2(error) {
  return error instanceof Error ? error.message : String(error);
}
function workflowCommandValue(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
function warnQueueFailure(error) {
  const detail = message2(error);
  const warning = `Queue enrolment did not complete: ${detail}. The proof result is unchanged. Re-run this job to try enrolment again.`;
  console.warn(`::warning::${workflowCommandValue(warning)}`);
  summary(`> \u26A0\uFE0F ${warning}`);
}
async function runAction() {
  const inputs = readActionInputs();
  const context = readActionContext();
  const client = new ActionClient({
    endpoint: inputs.endpoint,
    githubApiUrl: inputs.githubApiUrl,
    githubToken: inputs.githubToken
  });
  if (context.kind === "candidate_report") {
    await client.reportCandidate(context);
    console.log("Thwip Queue accepted the candidate report");
    return 0;
  }
  return verifyAndAuthorize(
    () => verifyPullRequest(context, client),
    async () => {
      const reason = await client.authorize({
        repositoryId: context.repositoryId,
        pullRequestNumber: context.pullRequestNumber,
        headSha: context.headSha,
        baseRef: `refs/heads/${context.baseRefName}`,
        authorGithubUserId: context.authorGithubUserId,
        draft: context.draft
      });
      console.log(`Thwip Queue says: ${reason}`);
    },
    (error) => summary(`thwip: FAIL \u2014 ${message2(error)}`),
    warnQueueFailure
  );
}

// src/entry.ts
runAction().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  console.error(`thwip: FAIL \u2014 ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
