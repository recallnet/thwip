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
var import_node_fs = require("node:fs");

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/buffer_utils.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var MAX_INT32 = 2 ** 32;
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0);
  const buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers) {
    buf.set(buffer, i);
    i += buffer.length;
  }
  return buf;
}
function encode(string) {
  const bytes = new Uint8Array(string.length);
  for (let i = 0; i < string.length; i++) {
    const code = string.charCodeAt(i);
    if (code > 127) {
      throw new TypeError("non-ASCII string encountered in encode()");
    }
    bytes[i] = code;
  }
  return bytes;
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/base64.js
function decodeBase64(encoded) {
  if (Uint8Array.fromBase64) {
    return Uint8Array.fromBase64(encoded);
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/util/base64url.js
function decode(input) {
  if (Uint8Array.fromBase64) {
    return Uint8Array.fromBase64(typeof input === "string" ? input : decoder.decode(input), {
      alphabet: "base64url"
    });
  }
  let encoded = input;
  if (encoded instanceof Uint8Array) {
    encoded = decoder.decode(encoded);
  }
  encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeBase64(encoded);
  } catch {
    throw new TypeError("The input to be decoded is not correctly encoded.");
  }
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/crypto_key.js
var unusable = (name, prop = "algorithm.name") => new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`);
var isAlgorithm = (algorithm, name) => algorithm.name === name;
function getHashLength(hash) {
  return parseInt(hash.name.slice(4), 10);
}
function checkHashLength(algorithm, expected) {
  const actual = getHashLength(algorithm.hash);
  if (actual !== expected)
    throw unusable(`SHA-${expected}`, "algorithm.hash");
}
function getNamedCurve(alg) {
  switch (alg) {
    case "ES256":
      return "P-256";
    case "ES384":
      return "P-384";
    case "ES512":
      return "P-521";
    default:
      throw new Error("unreachable");
  }
}
function checkUsage(key, usage) {
  if (usage && !key.usages.includes(usage)) {
    throw new TypeError(`CryptoKey does not support this operation, its usages must include ${usage}.`);
  }
}
function checkSigCryptoKey(key, alg, usage) {
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512": {
      if (!isAlgorithm(key.algorithm, "HMAC"))
        throw unusable("HMAC");
      checkHashLength(key.algorithm, parseInt(alg.slice(2), 10));
      break;
    }
    case "RS256":
    case "RS384":
    case "RS512": {
      if (!isAlgorithm(key.algorithm, "RSASSA-PKCS1-v1_5"))
        throw unusable("RSASSA-PKCS1-v1_5");
      checkHashLength(key.algorithm, parseInt(alg.slice(2), 10));
      break;
    }
    case "PS256":
    case "PS384":
    case "PS512": {
      if (!isAlgorithm(key.algorithm, "RSA-PSS"))
        throw unusable("RSA-PSS");
      checkHashLength(key.algorithm, parseInt(alg.slice(2), 10));
      break;
    }
    case "Ed25519":
    case "EdDSA": {
      if (!isAlgorithm(key.algorithm, "Ed25519"))
        throw unusable("Ed25519");
      break;
    }
    case "ML-DSA-44":
    case "ML-DSA-65":
    case "ML-DSA-87": {
      if (!isAlgorithm(key.algorithm, alg))
        throw unusable(alg);
      break;
    }
    case "ES256":
    case "ES384":
    case "ES512": {
      if (!isAlgorithm(key.algorithm, "ECDSA"))
        throw unusable("ECDSA");
      const expected = getNamedCurve(alg);
      const actual = key.algorithm.namedCurve;
      if (actual !== expected)
        throw unusable(expected, "algorithm.namedCurve");
      break;
    }
    default:
      throw new TypeError("CryptoKey does not support this operation");
  }
  checkUsage(key, usage);
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/invalid_key_input.js
function message(msg, actual, ...types) {
  types = types.filter(Boolean);
  if (types.length > 2) {
    const last = types.pop();
    msg += `one of type ${types.join(", ")}, or ${last}.`;
  } else if (types.length === 2) {
    msg += `one of type ${types[0]} or ${types[1]}.`;
  } else {
    msg += `of type ${types[0]}.`;
  }
  if (actual == null) {
    msg += ` Received ${actual}`;
  } else if (typeof actual === "function" && actual.name) {
    msg += ` Received function ${actual.name}`;
  } else if (typeof actual === "object" && actual != null) {
    if (actual.constructor?.name) {
      msg += ` Received an instance of ${actual.constructor.name}`;
    }
  }
  return msg;
}
var invalidKeyInput = (actual, ...types) => message("Key must be ", actual, ...types);
var withAlg = (alg, actual, ...types) => message(`Key for the ${alg} algorithm must be `, actual, ...types);

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/util/errors.js
var JOSEError = class extends Error {
  static code = "ERR_JOSE_GENERIC";
  code = "ERR_JOSE_GENERIC";
  constructor(message2, options) {
    super(message2, options);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
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
var JWSSignatureVerificationFailed = class extends JOSEError {
  static code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  constructor(message2 = "signature verification failed", options) {
    super(message2, options);
  }
};

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/is_key_like.js
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

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/helpers.js
var unprotected = Symbol();
function decodeBase64url(value, label, ErrorClass) {
  try {
    return decode(value);
  } catch {
    throw new ErrorClass(`Failed to base64url decode the ${label}`);
  }
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/type_checks.js
var isObjectLike = (value) => typeof value === "object" && value !== null;
function isObject(input) {
  if (!isObjectLike(input) || Object.prototype.toString.call(input) !== "[object Object]") {
    return false;
  }
  if (Object.getPrototypeOf(input) === null) {
    return true;
  }
  let proto = input;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }
  return Object.getPrototypeOf(input) === proto;
}
function isDisjoint(...headers) {
  const sources = headers.filter(Boolean);
  if (sources.length === 0 || sources.length === 1) {
    return true;
  }
  let acc;
  for (const header of sources) {
    const parameters = Object.keys(header);
    if (!acc || acc.size === 0) {
      acc = new Set(parameters);
      continue;
    }
    for (const parameter of parameters) {
      if (acc.has(parameter)) {
        return false;
      }
      acc.add(parameter);
    }
  }
  return true;
}
var isJWK = (key) => isObject(key) && typeof key.kty === "string";
var isPrivateJWK = (key) => key.kty !== "oct" && (key.kty === "AKP" && typeof key.priv === "string" || typeof key.d === "string");
var isPublicJWK = (key) => key.kty !== "oct" && key.d === void 0 && key.priv === void 0;
var isSecretJWK = (key) => key.kty === "oct" && typeof key.k === "string";

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/signing.js
function checkKeyLength(alg, key) {
  if (alg.startsWith("RS") || alg.startsWith("PS")) {
    const { modulusLength } = key.algorithm;
    if (typeof modulusLength !== "number" || modulusLength < 2048) {
      throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
    }
  }
}
function subtleAlgorithm(alg, algorithm) {
  const hash = `SHA-${alg.slice(-3)}`;
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512":
      return { hash, name: "HMAC" };
    case "PS256":
    case "PS384":
    case "PS512":
      return { hash, name: "RSA-PSS", saltLength: parseInt(alg.slice(-3), 10) >> 3 };
    case "RS256":
    case "RS384":
    case "RS512":
      return { hash, name: "RSASSA-PKCS1-v1_5" };
    case "ES256":
    case "ES384":
    case "ES512":
      return { hash, name: "ECDSA", namedCurve: algorithm.namedCurve };
    case "Ed25519":
    case "EdDSA":
      return { name: "Ed25519" };
    case "ML-DSA-44":
    case "ML-DSA-65":
    case "ML-DSA-87":
      return { name: alg };
    default:
      throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  }
}
async function getSigKey(alg, key, usage) {
  if (key instanceof Uint8Array) {
    if (!alg.startsWith("HS")) {
      throw new TypeError(invalidKeyInput(key, "CryptoKey", "KeyObject", "JSON Web Key"));
    }
    return crypto.subtle.importKey("raw", key, { hash: `SHA-${alg.slice(-3)}`, name: "HMAC" }, false, [usage]);
  }
  checkSigCryptoKey(key, alg, usage);
  return key;
}
async function verify(alg, key, signature, data) {
  const cryptoKey = await getSigKey(alg, key, "verify");
  checkKeyLength(alg, cryptoKey);
  const algorithm = subtleAlgorithm(alg, cryptoKey.algorithm);
  try {
    return await crypto.subtle.verify(algorithm, cryptoKey, signature, data);
  } catch {
    return false;
  }
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/jwk_to_key.js
var unsupportedAlg = 'Invalid or unsupported JWK "alg" (Algorithm) Parameter value';
function subtleMapping(jwk) {
  let algorithm;
  let keyUsages;
  switch (jwk.kty) {
    case "AKP": {
      switch (jwk.alg) {
        case "ML-DSA-44":
        case "ML-DSA-65":
        case "ML-DSA-87":
          algorithm = { name: jwk.alg };
          keyUsages = jwk.priv ? ["sign"] : ["verify"];
          break;
        default:
          throw new JOSENotSupported(unsupportedAlg);
      }
      break;
    }
    case "RSA": {
      switch (jwk.alg) {
        case "PS256":
        case "PS384":
        case "PS512":
          algorithm = { name: "RSA-PSS", hash: `SHA-${jwk.alg.slice(-3)}` };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "RS256":
        case "RS384":
        case "RS512":
          algorithm = { name: "RSASSA-PKCS1-v1_5", hash: `SHA-${jwk.alg.slice(-3)}` };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "RSA-OAEP":
        case "RSA-OAEP-256":
        case "RSA-OAEP-384":
        case "RSA-OAEP-512":
          algorithm = {
            name: "RSA-OAEP",
            hash: `SHA-${parseInt(jwk.alg.slice(-3), 10) || 1}`
          };
          keyUsages = jwk.d ? ["decrypt", "unwrapKey"] : ["encrypt", "wrapKey"];
          break;
        default:
          throw new JOSENotSupported(unsupportedAlg);
      }
      break;
    }
    case "EC": {
      switch (jwk.alg) {
        case "ES256":
        case "ES384":
        case "ES512":
          algorithm = {
            name: "ECDSA",
            namedCurve: { ES256: "P-256", ES384: "P-384", ES512: "P-521" }[jwk.alg]
          };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ECDH-ES":
        case "ECDH-ES+A128KW":
        case "ECDH-ES+A192KW":
        case "ECDH-ES+A256KW":
          algorithm = { name: "ECDH", namedCurve: jwk.crv };
          keyUsages = jwk.d ? ["deriveBits"] : [];
          break;
        default:
          throw new JOSENotSupported(unsupportedAlg);
      }
      break;
    }
    case "OKP": {
      switch (jwk.alg) {
        case "Ed25519":
        case "EdDSA":
          algorithm = { name: "Ed25519" };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ECDH-ES":
        case "ECDH-ES+A128KW":
        case "ECDH-ES+A192KW":
        case "ECDH-ES+A256KW":
          algorithm = { name: jwk.crv };
          keyUsages = jwk.d ? ["deriveBits"] : [];
          break;
        default:
          throw new JOSENotSupported(unsupportedAlg);
      }
      break;
    }
    default:
      throw new JOSENotSupported('Invalid or unsupported JWK "kty" (Key Type) Parameter value');
  }
  return { algorithm, keyUsages };
}
async function jwkToKey(jwk) {
  if (!jwk.alg) {
    throw new TypeError('"alg" argument is required when "jwk.alg" is not present');
  }
  const { algorithm, keyUsages } = subtleMapping(jwk);
  const keyData = { ...jwk };
  if (keyData.kty !== "AKP") {
    delete keyData.alg;
  }
  delete keyData.use;
  return crypto.subtle.importKey("jwk", keyData, algorithm, jwk.ext ?? (jwk.d || jwk.priv ? false : true), jwk.key_ops ?? keyUsages);
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/normalize_key.js
var unusableForAlg = "given KeyObject instance cannot be used for this algorithm";
var cache;
var handleJWK = async (key, jwk, alg, freeze = false) => {
  cache ||= /* @__PURE__ */ new WeakMap();
  let cached = cache.get(key);
  if (cached?.[alg]) {
    return cached[alg];
  }
  const cryptoKey = await jwkToKey({ ...jwk, alg });
  if (freeze)
    Object.freeze(key);
  if (!cached) {
    cache.set(key, { [alg]: cryptoKey });
  } else {
    cached[alg] = cryptoKey;
  }
  return cryptoKey;
};
var handleKeyObject = (keyObject, alg) => {
  cache ||= /* @__PURE__ */ new WeakMap();
  let cached = cache.get(keyObject);
  if (cached?.[alg]) {
    return cached[alg];
  }
  const isPublic = keyObject.type === "public";
  const extractable = isPublic ? true : false;
  let cryptoKey;
  if (keyObject.asymmetricKeyType === "x25519") {
    switch (alg) {
      case "ECDH-ES":
      case "ECDH-ES+A128KW":
      case "ECDH-ES+A192KW":
      case "ECDH-ES+A256KW":
        break;
      default:
        throw new TypeError(unusableForAlg);
    }
    cryptoKey = keyObject.toCryptoKey(keyObject.asymmetricKeyType, extractable, isPublic ? [] : ["deriveBits"]);
  }
  if (keyObject.asymmetricKeyType === "ed25519") {
    if (alg !== "EdDSA" && alg !== "Ed25519") {
      throw new TypeError(unusableForAlg);
    }
    cryptoKey = keyObject.toCryptoKey(keyObject.asymmetricKeyType, extractable, [
      isPublic ? "verify" : "sign"
    ]);
  }
  switch (keyObject.asymmetricKeyType) {
    case "ml-dsa-44":
    case "ml-dsa-65":
    case "ml-dsa-87": {
      if (alg !== keyObject.asymmetricKeyType.toUpperCase()) {
        throw new TypeError(unusableForAlg);
      }
      cryptoKey = keyObject.toCryptoKey(keyObject.asymmetricKeyType, extractable, [
        isPublic ? "verify" : "sign"
      ]);
    }
  }
  if (keyObject.asymmetricKeyType === "rsa") {
    let hash;
    switch (alg) {
      case "RSA-OAEP":
        hash = "SHA-1";
        break;
      case "RS256":
      case "PS256":
      case "RSA-OAEP-256":
        hash = "SHA-256";
        break;
      case "RS384":
      case "PS384":
      case "RSA-OAEP-384":
        hash = "SHA-384";
        break;
      case "RS512":
      case "PS512":
      case "RSA-OAEP-512":
        hash = "SHA-512";
        break;
      default:
        throw new TypeError(unusableForAlg);
    }
    if (alg.startsWith("RSA-OAEP")) {
      return keyObject.toCryptoKey({
        name: "RSA-OAEP",
        hash
      }, extractable, isPublic ? ["encrypt"] : ["decrypt"]);
    }
    cryptoKey = keyObject.toCryptoKey({
      name: alg.startsWith("PS") ? "RSA-PSS" : "RSASSA-PKCS1-v1_5",
      hash
    }, extractable, [isPublic ? "verify" : "sign"]);
  }
  if (keyObject.asymmetricKeyType === "ec") {
    const nist = /* @__PURE__ */ new Map([
      ["prime256v1", "P-256"],
      ["secp384r1", "P-384"],
      ["secp521r1", "P-521"]
    ]);
    const namedCurve = nist.get(keyObject.asymmetricKeyDetails?.namedCurve);
    if (!namedCurve) {
      throw new TypeError(unusableForAlg);
    }
    const expectedCurve = { ES256: "P-256", ES384: "P-384", ES512: "P-521" };
    if (expectedCurve[alg] && namedCurve === expectedCurve[alg]) {
      cryptoKey = keyObject.toCryptoKey({
        name: "ECDSA",
        namedCurve
      }, extractable, [isPublic ? "verify" : "sign"]);
    }
    if (alg.startsWith("ECDH-ES")) {
      cryptoKey = keyObject.toCryptoKey({
        name: "ECDH",
        namedCurve
      }, extractable, isPublic ? [] : ["deriveBits"]);
    }
  }
  if (!cryptoKey) {
    throw new TypeError(unusableForAlg);
  }
  if (!cached) {
    cache.set(keyObject, { [alg]: cryptoKey });
  } else {
    cached[alg] = cryptoKey;
  }
  return cryptoKey;
};
async function normalizeKey(key, alg) {
  if (key instanceof Uint8Array) {
    return key;
  }
  if (isCryptoKey(key)) {
    return key;
  }
  if (isKeyObject(key)) {
    if (key.type === "secret") {
      return key.export();
    }
    if ("toCryptoKey" in key && typeof key.toCryptoKey === "function") {
      try {
        return handleKeyObject(key, alg);
      } catch (err) {
        if (err instanceof TypeError) {
          throw err;
        }
      }
    }
    let jwk = key.export({ format: "jwk" });
    return handleJWK(key, jwk, alg);
  }
  if (isJWK(key)) {
    if (key.k) {
      return decode(key.k);
    }
    return handleJWK(key, key, alg, true);
  }
  throw new Error("unreachable");
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/key/import.js
async function importJWK(jwk, alg, options) {
  if (!isObject(jwk)) {
    throw new TypeError("JWK must be an object");
  }
  let ext;
  alg ??= jwk.alg;
  ext ??= options?.extractable ?? jwk.ext;
  switch (jwk.kty) {
    case "oct":
      if (typeof jwk.k !== "string" || !jwk.k) {
        throw new TypeError('missing "k" (Key Value) Parameter value');
      }
      return decode(jwk.k);
    case "RSA":
      if ("oth" in jwk && jwk.oth !== void 0) {
        throw new JOSENotSupported('RSA JWK "oth" (Other Primes Info) Parameter value is not supported');
      }
      return jwkToKey({ ...jwk, alg, ext });
    case "AKP": {
      if (typeof jwk.alg !== "string" || !jwk.alg) {
        throw new TypeError('missing "alg" (Algorithm) Parameter value');
      }
      if (alg !== void 0 && alg !== jwk.alg) {
        throw new TypeError("JWK alg and alg option value mismatch");
      }
      return jwkToKey({ ...jwk, ext });
    }
    case "EC":
    case "OKP":
      return jwkToKey({ ...jwk, alg, ext });
    default:
      throw new JOSENotSupported('Unsupported "kty" (Key Type) Parameter value');
  }
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/validate_crit.js
function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
  if (joseHeader.crit !== void 0 && protectedHeader?.crit === void 0) {
    throw new Err('"crit" (Critical) Header Parameter MUST be integrity protected');
  }
  if (!protectedHeader || protectedHeader.crit === void 0) {
    return /* @__PURE__ */ new Set();
  }
  if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input !== "string" || input.length === 0)) {
    throw new Err('"crit" (Critical) Header Parameter MUST be an array of non-empty strings when present');
  }
  let recognized;
  if (recognizedOption !== void 0) {
    recognized = new Map([...Object.entries(recognizedOption), ...recognizedDefault.entries()]);
  } else {
    recognized = recognizedDefault;
  }
  for (const parameter of protectedHeader.crit) {
    if (!recognized.has(parameter)) {
      throw new JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
    }
    if (joseHeader[parameter] === void 0) {
      throw new Err(`Extension Header Parameter "${parameter}" is missing`);
    }
    if (recognized.get(parameter) && protectedHeader[parameter] === void 0) {
      throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
    }
  }
  return new Set(protectedHeader.crit);
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/validate_algorithms.js
function validateAlgorithms(option, algorithms) {
  if (algorithms !== void 0 && (!Array.isArray(algorithms) || algorithms.some((s) => typeof s !== "string"))) {
    throw new TypeError(`"${option}" option must be an array of strings`);
  }
  if (!algorithms) {
    return void 0;
  }
  return new Set(algorithms);
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/lib/check_key_type.js
var tag = (key) => key?.[Symbol.toStringTag];
var jwkMatchesOp = (alg, key, usage) => {
  if (key.use !== void 0) {
    let expected;
    switch (usage) {
      case "sign":
      case "verify":
        expected = "sig";
        break;
      case "encrypt":
      case "decrypt":
        expected = "enc";
        break;
    }
    if (key.use !== expected) {
      throw new TypeError(`Invalid key for this operation, its "use" must be "${expected}" when present`);
    }
  }
  if (key.alg !== void 0 && key.alg !== alg) {
    throw new TypeError(`Invalid key for this operation, its "alg" must be "${alg}" when present`);
  }
  if (Array.isArray(key.key_ops)) {
    let expectedKeyOp;
    switch (true) {
      case (usage === "sign" || usage === "verify"):
      case alg === "dir":
      case alg.includes("CBC-HS"):
        expectedKeyOp = usage;
        break;
      case alg.startsWith("PBES2"):
        expectedKeyOp = "deriveBits";
        break;
      case /^A\d{3}(?:GCM)?(?:KW)?$/.test(alg):
        if (!alg.includes("GCM") && alg.endsWith("KW")) {
          expectedKeyOp = usage === "encrypt" ? "wrapKey" : "unwrapKey";
        } else {
          expectedKeyOp = usage;
        }
        break;
      case (usage === "encrypt" && alg.startsWith("RSA")):
        expectedKeyOp = "wrapKey";
        break;
      case usage === "decrypt":
        expectedKeyOp = alg.startsWith("RSA") ? "unwrapKey" : "deriveBits";
        break;
    }
    if (expectedKeyOp && key.key_ops?.includes?.(expectedKeyOp) === false) {
      throw new TypeError(`Invalid key for this operation, its "key_ops" must include "${expectedKeyOp}" when present`);
    }
  }
  return true;
};
var symmetricTypeCheck = (alg, key, usage) => {
  if (key instanceof Uint8Array)
    return;
  if (isJWK(key)) {
    if (isSecretJWK(key) && jwkMatchesOp(alg, key, usage))
      return;
    throw new TypeError(`JSON Web Key for symmetric algorithms must have JWK "kty" (Key Type) equal to "oct" and the JWK "k" (Key Value) present`);
  }
  if (!isKeyLike(key)) {
    throw new TypeError(withAlg(alg, key, "CryptoKey", "KeyObject", "JSON Web Key", "Uint8Array"));
  }
  if (key.type !== "secret") {
    throw new TypeError(`${tag(key)} instances for symmetric algorithms must be of type "secret"`);
  }
};
var asymmetricTypeCheck = (alg, key, usage) => {
  if (isJWK(key)) {
    switch (usage) {
      case "decrypt":
      case "sign":
        if (isPrivateJWK(key) && jwkMatchesOp(alg, key, usage))
          return;
        throw new TypeError(`JSON Web Key for this operation must be a private JWK`);
      case "encrypt":
      case "verify":
        if (isPublicJWK(key) && jwkMatchesOp(alg, key, usage))
          return;
        throw new TypeError(`JSON Web Key for this operation must be a public JWK`);
    }
  }
  if (!isKeyLike(key)) {
    throw new TypeError(withAlg(alg, key, "CryptoKey", "KeyObject", "JSON Web Key"));
  }
  if (key.type === "secret") {
    throw new TypeError(`${tag(key)} instances for asymmetric algorithms must not be of type "secret"`);
  }
  if (key.type === "public") {
    switch (usage) {
      case "sign":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm signing must be of type "private"`);
      case "decrypt":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm decryption must be of type "private"`);
    }
  }
  if (key.type === "private") {
    switch (usage) {
      case "verify":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm verifying must be of type "public"`);
      case "encrypt":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm encryption must be of type "public"`);
    }
  }
};
function checkKeyType(alg, key, usage) {
  switch (alg.substring(0, 2)) {
    case "A1":
    case "A2":
    case "di":
    case "HS":
    case "PB":
      symmetricTypeCheck(alg, key, usage);
      break;
    default:
      asymmetricTypeCheck(alg, key, usage);
  }
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/jws/flattened/verify.js
async function flattenedVerify(jws, key, options) {
  if (!isObject(jws)) {
    throw new JWSInvalid("Flattened JWS must be an object");
  }
  if (jws.protected === void 0 && jws.header === void 0) {
    throw new JWSInvalid('Flattened JWS must have either of the "protected" or "header" members');
  }
  if (jws.protected !== void 0 && typeof jws.protected !== "string") {
    throw new JWSInvalid("JWS Protected Header incorrect type");
  }
  if (jws.payload === void 0) {
    throw new JWSInvalid("JWS Payload missing");
  }
  if (typeof jws.signature !== "string") {
    throw new JWSInvalid("JWS Signature missing or incorrect type");
  }
  if (jws.header !== void 0 && !isObject(jws.header)) {
    throw new JWSInvalid("JWS Unprotected Header incorrect type");
  }
  let parsedProt = {};
  if (jws.protected) {
    try {
      const protectedHeader = decode(jws.protected);
      parsedProt = JSON.parse(decoder.decode(protectedHeader));
    } catch {
      throw new JWSInvalid("JWS Protected Header is invalid");
    }
  }
  if (!isDisjoint(parsedProt, jws.header)) {
    throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
  }
  const joseHeader = {
    ...parsedProt,
    ...jws.header
  };
  const extensions = validateCrit(JWSInvalid, /* @__PURE__ */ new Map([["b64", true]]), options?.crit, parsedProt, joseHeader);
  let b64 = true;
  if (extensions.has("b64")) {
    b64 = parsedProt.b64;
    if (typeof b64 !== "boolean") {
      throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
    }
  }
  const { alg } = joseHeader;
  if (typeof alg !== "string" || !alg) {
    throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
  }
  const algorithms = options && validateAlgorithms("algorithms", options.algorithms);
  if (algorithms && !algorithms.has(alg)) {
    throw new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
  }
  if (b64) {
    if (typeof jws.payload !== "string") {
      throw new JWSInvalid("JWS Payload must be a string");
    }
  } else if (typeof jws.payload !== "string" && !(jws.payload instanceof Uint8Array)) {
    throw new JWSInvalid("JWS Payload must be a string or an Uint8Array instance");
  }
  let resolvedKey = false;
  if (typeof key === "function") {
    key = await key(parsedProt, jws);
    resolvedKey = true;
  }
  checkKeyType(alg, key, "verify");
  const data = concat(jws.protected !== void 0 ? encode(jws.protected) : new Uint8Array(), encode("."), typeof jws.payload === "string" ? b64 ? encode(jws.payload) : encoder.encode(jws.payload) : jws.payload);
  const signature = decodeBase64url(jws.signature, "signature", JWSInvalid);
  const k = await normalizeKey(key, alg);
  const verified = await verify(alg, k, signature, data);
  if (!verified) {
    throw new JWSSignatureVerificationFailed();
  }
  let payload;
  if (b64) {
    payload = decodeBase64url(jws.payload, "payload", JWSInvalid);
  } else if (typeof jws.payload === "string") {
    payload = encoder.encode(jws.payload);
  } else {
    payload = jws.payload;
  }
  const result = { payload };
  if (jws.protected !== void 0) {
    result.protectedHeader = parsedProt;
  }
  if (jws.header !== void 0) {
    result.unprotectedHeader = jws.header;
  }
  if (resolvedKey) {
    return { ...result, key: k };
  }
  return result;
}

// ../../node_modules/.pnpm/jose@6.2.4/node_modules/jose/dist/webapi/jws/compact/verify.js
async function compactVerify(jws, key, options) {
  if (jws instanceof Uint8Array) {
    jws = decoder.decode(jws);
  }
  if (typeof jws !== "string") {
    throw new JWSInvalid("Compact JWS must be a string or Uint8Array");
  }
  const { 0: protectedHeader, 1: payload, 2: signature, length } = jws.split(".");
  if (length !== 3) {
    throw new JWSInvalid("Invalid Compact JWS");
  }
  const verified = await flattenedVerify({ payload, protected: protectedHeader, signature }, key, options);
  const result = { payload: verified.payload, protectedHeader: verified.protectedHeader };
  if (typeof key === "function") {
    return { ...result, key: verified.key };
  }
  return result;
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
  const sig = str(s0["sig"], "sig", 8192);
  if (!sig.ok)
    return sig;
  return {
    ok: true,
    value: {
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: payload.value,
      signatures: [{ keyid: keyid.value, sig: sig.value }]
    }
  };
}
function parseSuite(v, i) {
  if (!isRecord(v))
    return fail(`suite[${i}] not an object`);
  const id = v["id"];
  if (typeof id !== "string" || !SUITE_ID_RE.test(id))
    return fail(`suite[${i}].id invalid`);
  const status = v["status"];
  if (status !== "passed" && status !== "failed" && status !== "skipped")
    return fail(`suite[${i}].status invalid`);
  const durationMs = v["durationMs"];
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return fail(`suite[${i}].durationMs invalid`);
  }
  const out = { id, status, durationMs };
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
  if (evaluationMode !== "head-tree" && evaluationMode !== "merge-tree")
    return fail("git.evaluationMode invalid");
  let mergeTreeOid;
  if (git["mergeTreeOid"] !== void 0) {
    if (typeof git["mergeTreeOid"] !== "string" || !OID_RE.test(git["mergeTreeOid"]))
      return fail("git.mergeTreeOid invalid");
    mergeTreeOid = git["mergeTreeOid"];
  }
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
      evaluationMode,
      ...mergeTreeOid !== void 0 ? { mergeTreeOid } : {}
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
  try {
    sigOk = await deps.verifySshSignature({
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
  if (bundle.policy.evaluationMode === "merge-tree") {
    const claimed = pred.git.mergeTreeOid;
    if (claimed === void 0) {
      return res("SUBJECT_TREE_MISMATCH", "this project verifies the merged tree and the proof does not name one; upgrade the thwip CLI and run the tests again on the merge of your branch with the base", { statement });
    }
    if (facts.mergeTreeOid === void 0) {
      return res("SUBJECT_TREE_MISMATCH", "this project verifies the merged tree and the checker could not read the merge of this branch with the base from GitHub; retry once GitHub has computed the merge", { statement });
    }
    if (claimed !== facts.mergeTreeOid) {
      return res("SUBJECT_TREE_MISMATCH", `the proof names merge tree ${claimed} and GitHub merges this branch into the base as ${facts.mergeTreeOid}; run the tests again on the current merge`, { statement });
    }
  }
  const policyEligible = pred.policy.digest === bundle.activePolicyDigest || bundle.gracePolicyDigests.includes(pred.policy.digest);
  if (!policyEligible)
    return res("POLICY_NOT_ACTIVE", pred.policy.digest, { statement });
  if (pred.git.evaluationMode !== bundle.policy.evaluationMode) {
    return res("POLICY_NOT_ACTIVE", "evaluation mode mismatch", { statement });
  }
  if (pred.pipeline.digest !== bundle.policy.pipeline.digest || pred.pipeline.runner !== bundle.policy.pipeline.runner) {
    return res("PIPELINE_DIGEST_MISMATCH", void 0, { statement });
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
  if (!bundle.policy.allowAuthorAsSigner && facts.prAuthorGithubUserId === key.githubUserId) {
    return res("SIGNER_PERMISSION_INSUFFICIENT", "author may not sign", { statement });
  }
  if (bundle.policy.requireGithubKeyPresence) {
    if (!deps.githubUserSigningKeys) {
      return res("SIGNER_KEY_UNKNOWN", "this project requires the signing key to be published on the signer's GitHub account and the checker cannot read GitHub's key list", { statement });
    }
    let published;
    try {
      published = await deps.githubUserSigningKeys(key.githubUserId);
    } catch {
      return res("SIGNER_KEY_UNKNOWN", "GitHub did not answer when asked which keys this signer publishes; try again", {
        statement
      });
    }
    const wanted = sshKeyBody(key.publicKey);
    if (wanted === void 0 || !published.some((line) => sshKeyBody(line) === wanted)) {
      return res("SIGNER_KEY_UNKNOWN", `key ${key.keyId} is not among the SSH keys ${key.githubUserId} publishes on GitHub; add it to the GitHub account or enroll the key that is there`, { statement });
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
    if (!suite)
      return res("SUITE_MISSING", required, { statement });
    if (suite.status !== "passed")
      return res("SUITE_NOT_PASSED", required, { statement });
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
  const audit = bundle.policy.audit;
  const mandatoryPaths = audit.mandatoryPaths ?? [];
  const basisPoints = audit.basisPoints ?? 0;
  if (mandatoryPaths.length > 0 || basisPoints > 0) {
    if (mandatoryPaths.length > 0 && facts.changedPaths === void 0) {
      return res("AUDIT_REQUIRED", "this project audits changes under protected paths and the checker could not read which paths this branch changes; retry, and if it persists ask an administrator to check the GitHub App's contents permission", { statement });
    }
    const touchesProtected = (facts.changedPaths ?? []).some((path) => mandatoryPaths.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)));
    if (touchesProtected || sampledForAudit(facts.treeOid, basisPoints)) {
      if (!deps.auditProof) {
        return res("AUDIT_REQUIRED", "this project audits a share of proofs by re-running them and no auditor is available to this checker; ask an administrator to enable the audit runner or lower the audit rate", { statement });
      }
      let outcome;
      try {
        outcome = await deps.auditProof({ statement, facts });
      } catch {
        return res("AUDIT_REQUIRED", "the audit re-run did not complete, so this proof is unaudited; run it again", {
          statement
        });
      }
      if (!outcome.agrees) {
        return res("AUDIT_DISAGREED", outcome.detail ?? "an independent re-run of this pipeline disagreed with the proof; run the tests again and look at what differs", { statement });
      }
    }
  }
  return res("PASS", void 0, { statement, signerKey: key });
}
var CLOCK_SKEW_TOLERANCE_MS = 6e4;
var LEASE_ALGORITHMS = /* @__PURE__ */ new Set(["ES256", "EdDSA"]);
function sampledForAudit(treeOid, basisPoints) {
  if (basisPoints <= 0)
    return false;
  if (basisPoints >= 1e4)
    return true;
  const bucket = Number.parseInt(treeOid.slice(0, 8), 16);
  if (!Number.isFinite(bucket))
    return true;
  return bucket % 1e4 < basisPoints;
}
function sshKeyBody(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2)
    return void 0;
  return `${parts[0]} ${parts[1]}`;
}
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
    const id = jwk?.kid;
    return typeof id !== "string" || id === kid;
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

// service-public.jwk.json
var service_public_jwk_default = {
  kty: "EC",
  x: "um1lpxU3JthsE-C8wiYSaon_h_hsaZAp9x8MZ6cUWjo",
  y: "YmW9EvHEHrChYQMwKEGdkFsXl8-HulgQRCzEKyb7q5o",
  crv: "P-256",
  kid: "thwip-svc-1",
  alg: "ES256"
};

// src/bundle-resolution.ts
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseBundleResolutionBody(value) {
  if (!record(value)) throw new Error("BUNDLE_UNAVAILABLE: resolver returned a non-object");
  if (value["state"] === "bootstrap_pending") {
    if (value["code"] !== "POLICY_AWAITING_FIRST_MERGE" || typeof value["repository"] !== "string" || typeof value["repositoryId"] !== "string" || typeof value["defaultBranch"] !== "string") {
      throw new Error("BUNDLE_UNAVAILABLE: malformed bootstrap state");
    }
    return {
      kind: "bootstrap_pending",
      code: value["code"],
      repository: value["repository"],
      repositoryId: value["repositoryId"],
      defaultBranch: value["defaultBranch"]
    };
  }
  if ((value["state"] === void 0 || value["state"] === "active") && typeof value["bundle"] === "string") {
    return { kind: "active", bundle: value["bundle"] };
  }
  throw new Error("BUNDLE_UNAVAILABLE: resolver returned neither an active bundle nor bootstrap state");
}

// src/main.ts
var API = process.env["GITHUB_API_URL"] ?? "https://api.github.com";
var TOKEN = process.env["GITHUB_TOKEN"] ?? "";
var ENDPOINT = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
function summary(line) {
  const f = process.env["GITHUB_STEP_SUMMARY"];
  if (f) (0, import_node_fs.appendFileSync)(f, line + "\n");
  console.log(line);
}
async function gh(path) {
  const res2 = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "thwip-action"
    }
  });
  if (!res2.ok) throw new Error(`GitHub API ${path} -> ${res2.status}`);
  return res2.json();
}
async function getOidcToken(audience) {
  const url = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const reqToken = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!url || !reqToken) throw new Error("OIDC not available; set permissions id-token: write");
  const res2 = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${reqToken}`, accept: "application/json" }
  });
  if (!res2.ok) throw new Error(`OIDC token request failed: ${res2.status}`);
  const body = await res2.json();
  return body.value;
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
async function fetchBundle(repositoryId, headSha, hints) {
  const oidc = await getOidcToken(`${ENDPOINT}/api/github-actions`);
  const res2 = await fetch(`${ENDPOINT}/v1/verification-bundles:resolve`, {
    method: "POST",
    headers: { authorization: `Bearer ${oidc}`, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId, headSha, ...hints })
  });
  if (!res2.ok) throw new Error(`BUNDLE_UNAVAILABLE: ${res2.status} ${await res2.text()}`);
  const resolution = parseBundleResolutionBody(await res2.json());
  if (resolution.kind === "bootstrap_pending") return resolution;
  const key = await importJWK(service_public_jwk_default, "ES256");
  const { payload, protectedHeader } = await compactVerify(resolution.bundle, key);
  if (protectedHeader.typ !== "thwip-bundle+jws") throw new Error("BUNDLE_SIGNATURE_INVALID: bad typ");
  return {
    kind: "active",
    bundle: JSON.parse(new TextDecoder().decode(payload))
  };
}
async function mergeBase(repoFullName, base, head) {
  const cmp = await gh(
    `/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${head}`
  );
  return cmp.merge_base_commit.sha;
}
async function requireBootstrapPrerequisites(fullName, ownerId, repositoryId, targets, firstCommit) {
  for (const target of targets) {
    const commit = target.prHeadSha === firstCommit.sha ? firstCommit : await gh(`/repos/${fullName}/git/commits/${target.prHeadSha}`);
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
      await gh(`/repos/${fullName}/contents/thwip.yaml?ref=${encodeURIComponent(commit.sha)}`);
    } catch {
      throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} has no committed thwip.yaml`);
    }
  }
}
async function main() {
  const eventName = process.env["GITHUB_EVENT_NAME"] ?? "";
  const event = JSON.parse((0, import_node_fs.readFileSync)(process.env["GITHUB_EVENT_PATH"], "utf8"));
  const repo = event["repository"];
  const repositoryId = String(repo["id"]);
  const ownerId = String(repo["owner"]["id"]);
  const fullName = repo["full_name"];
  const targets = [];
  let baseRefName;
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const pr = event["pull_request"];
    baseRefName = pr["base"]["ref"];
    targets.push({ prHeadSha: pr["head"]["sha"], prAuthorId: String(pr["user"]["id"]) });
  } else if (eventName === "merge_group") {
    const mg = event["merge_group"];
    baseRefName = mg["base_ref"].replace(/^refs\/heads\//, "");
    let cursor = mg["head_sha"];
    const baseSha = mg["base_sha"];
    let hops = 0;
    while (cursor !== baseSha && hops < 50) {
      const c = await gh(`/repos/${fullName}/git/commits/${cursor}`);
      if (c.parents.length >= 2) targets.push({ prHeadSha: c.parents[1].sha });
      if (c.parents.length === 0) break;
      cursor = c.parents[0].sha;
      hops++;
    }
    if (targets.length === 0) {
      summary("thwip: FAIL \u2014 merge group contains no mergeable PR entries");
      process.exit(1);
    }
  } else {
    summary(`thwip: FAIL \u2014 unsupported event ${eventName}`);
    process.exit(1);
  }
  const firstCommit = await gh(`/repos/${fullName}/git/commits/${targets[0].prHeadSha}`);
  const resolution = await fetchBundle(repositoryId, targets[0].prHeadSha, proofHints(firstCommit.message));
  if (resolution.kind === "bootstrap_pending") {
    await requireBootstrapPrerequisites(fullName, ownerId, repositoryId, targets, firstCommit);
    summary("## \u{1F7E1} `BOOTSTRAP_PENDING` \u2014 waiting for the first canonical policy");
    summary("");
    summary(
      `${resolution.repository} is enabled, but has no active policy yet. This successful bootstrap result keeps onboarding eligible for the native merge queue.`
    );
    summary("");
    summary(
      `A candidate \`thwip.yaml\` and structured proof bound to the exact repository tree are present on the head. This result does **not** approve that candidate policy or verify its signature. After merge, thwip derives and activates the exact policy from \`${resolution.defaultBranch}\`; later changes are verified under the policy that was already active.`
    );
    await recordObservation(repositoryId, firstCommit.sha, "BOOTSTRAP_PENDING");
    process.exit(0);
  }
  const bundle = resolution.bundle;
  let allPass = true;
  for (const target of targets) {
    const commit = target.prHeadSha === firstCommit.sha ? firstCommit : await gh(`/repos/${fullName}/git/commits/${target.prHeadSha}`);
    const baseSha = await mergeBase(fullName, baseRefName, target.prHeadSha);
    const facts = {
      ownerId,
      repositoryId,
      headSha: commit.sha,
      treeOid: commit.tree.sha,
      parentOids: commit.parents.map((p) => p.sha),
      baseRef: `refs/heads/${baseRefName}`,
      baseSha,
      objectFormat: commit.sha.length === 64 ? "sha256" : "sha1",
      ...target.prAuthorId !== void 0 ? { prAuthorGithubUserId: target.prAuthorId } : {}
    };
    const result = await verifyProof(
      { commitMessage: commit.message, facts, bundle, now: (/* @__PURE__ */ new Date()).toISOString() },
      {
        verifySshSignature,
        // Remote suites are proven by GitHub's own checks on this commit.
        remoteCheckConclusions: async (headSha) => {
          const runs = await gh(
            `/repos/${fullName}/commits/${headSha}/check-runs?per_page=100`
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
    if (result.code !== "PASS") allPass = false;
    if (result.code === "PASS" && result.statement) {
      await publishSuiteChecks(fullName, commit.sha, result.statement).catch(() => {
      });
    }
    if (result.code !== "VERIFICATION_PENDING") {
      await recordObservation(repositoryId, commit.sha, result.code);
    }
  }
  process.exit(allPass ? 0 : 1);
}
async function recordObservation(repositoryId, headSha, outcome) {
  try {
    const oidc = await getOidcToken(`${ENDPOINT}/api/github-actions`);
    await fetch(`${ENDPOINT}/v1/verification-observations`, {
      method: "POST",
      headers: { authorization: `Bearer ${oidc}`, "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId,
        headSha,
        outcome,
        runId: process.env["GITHUB_RUN_ID"] ?? null
      })
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
  ["Policy digest is the active policy", ["POLICY_NOT_ACTIVE"]],
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
async function publishSuiteChecks(fullName, headSha, statement) {
  const run = statement.predicate.run;
  let startMs = Date.parse(run.startedAt);
  for (const s of run.suites) {
    const started = new Date(startMs);
    const completed = new Date(startMs + s.durationMs);
    startMs += s.durationMs;
    await fetch(`${API}/repos/${fullName}/check-runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "thwip-action",
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
main().catch((e) => {
  summary(`thwip: FAIL \u2014 ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
