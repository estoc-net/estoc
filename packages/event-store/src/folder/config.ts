/**
 * `config.json` as vault-folder.md §6.1 and §11 read it: a JSON object
 * saying `estoc`, version 2, or the folder is refused — by `open`, and by
 * an import before a line is decoded.
 */

import { NotAVault } from "../errors.js";
import { isJsonObject, type JsonObject } from "../json.js";
import { CONFIG_FILE, text } from "./layout.js";

export const FORMAT = "estoc";
export const VERSION = 2;

export function parseJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(text(bytes));
  } catch (err) {
    throw new NotAVault(`${what} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The config `bytes` hold, checked: format `estoc`, version 2, or `NotAVault`. */
export function readConfig(bytes: Uint8Array): JsonObject {
  const config = parseJson(bytes, CONFIG_FILE);
  if (!isJsonObject(config)) {
    throw new NotAVault(`${CONFIG_FILE} is not a JSON object`);
  }
  if (config["format"] !== FORMAT) {
    throw new NotAVault(`${CONFIG_FILE}: format is ${JSON.stringify(config["format"])}, not ${JSON.stringify(FORMAT)}`);
  }
  if (config["version"] !== VERSION) {
    throw new NotAVault(`${CONFIG_FILE}: version ${JSON.stringify(config["version"])} is not ${VERSION}; this reader opens version ${VERSION} only`);
  }
  return config;
}
