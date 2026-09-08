/**
 * `config.json`, version 3: the one file that says what the folder is and
 * whose it is. The member set is closed — `format`, `version`,
 * `identity.anchor.{key,did}` and nothing else — and a reader refuses any
 * other spelling before it writes or interprets a byte. Immutable after
 * creation: written once by `create`, never through `FileStore`.
 */

import { NotAVault } from "../errors.js";
import { parseStrict } from "../jcs.js";
import { isJsonObject } from "../json.js";
import { CONFIG_FILE, prettyJson, text } from "./layout.js";

export const FORMAT = "estoc";
export const VERSION = 3;
/** The one key name the anchor derives under: fixed by the format. */
export const ANCHOR_KEY = "anchor";

/** What `config.json` holds. */
export interface Config {
  format: typeof FORMAT;
  version: typeof VERSION;
  identity: { anchor: { key: typeof ANCHOR_KEY; did: string } };
}

/** The members an object at `where` may have, exactly: any other, or any missing, is `NotAVault`. */
function closed(value: unknown, where: string, members: readonly string[]): Record<string, unknown> {
  if (!isJsonObject(value)) throw new NotAVault(`${where} is not a JSON object`);
  for (const member of members) {
    if (!Object.hasOwn(value, member)) throw new NotAVault(`${where} has no ${JSON.stringify(member)}`);
  }
  const extra = Object.keys(value).filter((k) => !members.includes(k));
  if (extra.length > 0) throw new NotAVault(`${where} has a member version ${VERSION} does not define: ${extra.map((k) => JSON.stringify(k)).join(", ")}`);
  return value;
}

/** `bytes` as JSON, strictly: UTF-8, no duplicate member; `NotAVault` naming `path` otherwise. */
export function parseJsonFile(bytes: Uint8Array, path: string): unknown {
  try {
    return parseStrict(text(bytes));
  } catch (err) {
    throw new NotAVault(`${path} is not JSON: ${err instanceof TypeError ? "not UTF-8" : err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The config `bytes` spell, or `NotAVault`: format `estoc`, the integer
 * 3 — every other version is refused in words a user can read — and an
 * anchor under the key `anchor` whose DID is a `did:key`, the form the
 * fixed anchor derivation yields. Whether the DID is this seed's is a
 * writable open's to check.
 */
export function parseConfig(bytes: Uint8Array, path = CONFIG_FILE): Config {
  const value = parseJsonFile(bytes, path);
  if (!isJsonObject(value)) throw new NotAVault(`${path} is not a JSON object`);
  // Format and version first, before the closed set: another version's file is refused as that, not as a member this version does not know.
  if (value["format"] !== FORMAT) throw new NotAVault(`${path}: format is ${JSON.stringify(value["format"])}, not ${JSON.stringify(FORMAT)}`);
  if (value["version"] !== VERSION) {
    throw new NotAVault(`${path}: version ${JSON.stringify(value["version"])} is not ${VERSION}; this reader opens version ${VERSION} vaults only`);
  }
  const config = closed(value, path, ["format", "version", "identity"]);
  const identity = closed(config["identity"], `${path}: identity`, ["anchor"]);
  const anchor = closed(identity["anchor"], `${path}: identity.anchor`, ["key", "did"]);
  if (anchor["key"] !== ANCHOR_KEY) throw new NotAVault(`${path}: identity.anchor.key is ${JSON.stringify(anchor["key"])}, not ${JSON.stringify(ANCHOR_KEY)}`);
  const did = anchor["did"];
  if (typeof did !== "string" || !did.startsWith("did:key:") || did.length <= "did:key:".length) {
    throw new NotAVault(`${path}: identity.anchor.did is not a did:key`);
  }
  return { format: FORMAT, version: VERSION, identity: { anchor: { key: ANCHOR_KEY, did } } };
}

/** The file as `create` writes it: pretty-printed, the members in a fixed order. */
export function encodeConfig(did: string): Uint8Array {
  return prettyJson({ format: FORMAT, version: VERSION, identity: { anchor: { key: ANCHOR_KEY, did } } });
}
