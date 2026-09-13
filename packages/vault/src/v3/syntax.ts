/**
 * The spellings the payload schemas check: what a DID, a DID URL, a
 * UUID of a given version, a key name, a message hash and a compact JWT
 * look like. Syntax only — whether a DID resolves or a JWT verifies is
 * for the code that holds the evidence.
 */

// DID Core ABNF: `did:` a method name of lowercase letters and digits, then
// colon-separated segments of ALPHA / DIGIT / "." / "-" / "_" / pct-encoded.
const DID_SYNTAX = "did:[a-z0-9]+:(?:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})*:)*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+";
const DID = new RegExp(`^${DID_SYNTAX}$`);
// A DID URL is a DID followed by RFC 3986 path-abempty, query and fragment
// (DID Core §3.2): every component is built from pchar, so a percent sign
// must begin a two-digit escape, and a space or a second `#` is not a URL.
// The only general URL parser in the platform, WHATWG `URL`, escapes and
// normalizes what it is given instead of refusing it, so it cannot decide
// whether the exact spelling is one.
const PCHAR = "(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})";
const DID_URL = new RegExp(`^${DID_SYNTAX}(?:/${PCHAR}*)*(?:\\?(?:${PCHAR}|[/?])*)?(?:#(?:${PCHAR}|[/?])*)?$`);
/** The did:peer numalgo-4 spellings: the short form is `4` and a base58btc multihash, the long form adds the encoded document. */
const PEER4_SHORT = /^did:peer:4z[1-9A-HJ-NP-Za-km-z]+$/;
const PEER4_LONG = /^did:peer:4z[1-9A-HJ-NP-Za-km-z]+:z[1-9A-HJ-NP-Za-km-z]+$/;
const UUID_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-V[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_V7 = new RegExp(`^${UUID_BODY.replace("V", "7")}$`);
const UUID_V5 = new RegExp(`^${UUID_BODY.replace("V", "5")}$`);
const UUID_V5_OR_V7 = new RegExp(`^${UUID_BODY.replace("V", "[57]")}$`);
const KEY_NAME = new RegExp(`^(?:did/${UUID_BODY.replace("V", "[57]")}/(?:authentication|key-agreement)|mediation/${UUID_BODY.replace("V", "7")}/me)$`);
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** 32 bytes as unpadded base64url: 43 characters, the last one carrying two zero bits. */
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const RECEIPT_ORDINAL = /^[1-9][0-9]*$/;

export const isDid = (value: unknown): value is string => typeof value === "string" && DID.test(value);
export const isDidUrl = (value: unknown): value is string => typeof value === "string" && DID_URL.test(value);
export const isPeer4Short = (value: unknown): value is string => typeof value === "string" && PEER4_SHORT.test(value);
export const isPeer4Long = (value: unknown): value is string => typeof value === "string" && PEER4_LONG.test(value);
export const isMintedId = (value: unknown): value is string => typeof value === "string" && UUID_V7.test(value);
export const isDerivedId = (value: unknown): value is string => typeof value === "string" && UUID_V5.test(value);
export const isEntityId = (value: unknown): value is string => typeof value === "string" && UUID_V5_OR_V7.test(value);
export const isKeyName = (value: unknown): value is string => typeof value === "string" && KEY_NAME.test(value);
export const isCompactJwt = (value: unknown): value is string => typeof value === "string" && COMPACT_JWT.test(value);
export const isMessageHash = (value: unknown): value is string => typeof value === "string" && SHA256_BASE64URL.test(value);
export const isReceiptOrdinal = (value: unknown): value is string => typeof value === "string" && RECEIPT_ORDINAL.test(value);
export const isEpochSeconds = (value: unknown): value is number => Number.isSafeInteger(value);
