/**
 * This copy's replica identity (vault-folder.md §10.1): `local/replica.json`,
 * holding the author every local append carries and the store
 * generation every change token names. Minted whole on the first
 * writable open and written before any append; read back strictly —
 * a file that is partly there, malformed, or not two canonical UUIDv7s
 * under exactly those two names is damage, never repaired by keeping
 * the half that parses (VF-6). No event records its creation (VF-7).
 */

import { v7 } from "uuid";

import type { VaultBackend } from "../../backend/types.js";
import { isAuthorId, isUuidv7, type AuthorId } from "../event.js";
import { parseStrict } from "../jcs.js";
import { isJsonObject } from "../json.js";
import { REPLICA_FILE, prettyJson, text } from "./layout.js";

/** The two values of `local/replica.json` (§10.1). */
export interface Replica {
  /** the event author of every local append (§6, event-store.md §4.1) */
  replica_id: AuthorId;
  /** this local physical event-store generation, which change tokens name (§10.3) */
  store_generation: string;
}

/** `local/replica.json` could not be read as a replica identity (§10.1): the recovery is a human's, never a partial repair. */
export class DamagedReplica extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(`${path}: ${message}`);
    this.name = "DamagedReplica";
  }
}

/** A fresh identity: two UUIDv7s from the standard generator (§10.1). */
export function mintReplica(): Replica {
  return { replica_id: v7() as AuthorId, store_generation: v7() };
}

const MEMBERS = ["replica_id", "store_generation"] as const;

/**
 * The replica `bytes` spell, or a throw: a JSON object with exactly
 * `replica_id` and `store_generation`, each a canonical lowercase
 * UUIDv7. Throws `DamagedReplica` naming `path` on anything else —
 * bad UTF-8, bad JSON, a missing or unknown member, an uppercase or
 * non-version-7 UUID.
 */
export function parseReplica(bytes: Uint8Array, path = REPLICA_FILE): Replica {
  let value: unknown;
  try {
    value = parseStrict(text(bytes));
  } catch (err) {
    throw new DamagedReplica(path, err instanceof TypeError ? "not UTF-8" : err instanceof Error ? err.message : String(err));
  }
  if (!isJsonObject(value)) throw new DamagedReplica(path, "not a JSON object");
  for (const member of MEMBERS) {
    if (!Object.hasOwn(value, member)) throw new DamagedReplica(path, `missing ${member}`);
  }
  const extra = Object.keys(value).filter((k) => !(MEMBERS as readonly string[]).includes(k));
  if (extra.length > 0) throw new DamagedReplica(path, `unknown member ${extra.map((k) => JSON.stringify(k)).join(", ")}`);
  const { replica_id, store_generation } = value;
  if (!isAuthorId(replica_id)) throw new DamagedReplica(path, "replica_id is not a canonical UUIDv7");
  if (!isUuidv7(store_generation)) throw new DamagedReplica(path, "store_generation is not a canonical UUIDv7");
  return { replica_id, store_generation };
}

/** The file as the folder writes it (§2, §10.1): pretty-printed, the two members in this order. */
export function encodeReplica(replica: Replica): Uint8Array {
  return prettyJson({ replica_id: replica.replica_id, store_generation: replica.store_generation });
}

/** The replica `local/replica.json` under `base` names, `null` when the whole file is absent; throws `DamagedReplica` otherwise. */
export async function readReplica(backend: VaultBackend, base: string): Promise<Replica | null> {
  const path = `${base}/${REPLICA_FILE}`;
  const bytes = await backend.read(path);
  return bytes === null ? null : parseReplica(bytes, path);
}

/**
 * The replica identity of a writable open (§10.1, §11.1 step 5): the
 * file's when it is there and whole; minted, durably written and
 * returned when the whole file is absent; `DamagedReplica` otherwise.
 * `mint` is the generator, injectable so a test can name the author.
 */
export async function openReplica(backend: VaultBackend, base: string, mint: () => Replica = mintReplica): Promise<Replica> {
  const have = await readReplica(backend, base);
  if (have !== null) return have;
  const minted = mint();
  await backend.write(`${base}/${REPLICA_FILE}`, encodeReplica(minted));
  return minted;
}
