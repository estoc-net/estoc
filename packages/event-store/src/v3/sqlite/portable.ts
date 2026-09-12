/**
 * A portable snapshot read as a vault, and the validation that says
 * whether it is one. Nothing here writes.
 */

import { DamagedObject, InvalidSnapshot, InvalidSqlValue, SnapshotTooLarge, SqliteError, UnsupportedOperation } from "../errors.js";
import { matches, type Cid, type Damaged, type Event, type Filter } from "../event.js";
import type { VaultMetadata } from "../keystore.js";
import { chunksOf, rawCidOf, sortCids } from "../objects.js";
import type { HeldRoots, Vault, VaultEvents, VaultObjects } from "../vault.js";
import { decodeText, type SqliteDriver } from "./driver.js";
import { EVENT_COLUMNS, eventFilterSql, readEventRows } from "./events.js";
import { SqliteObjectStore } from "./objects.js";
import type { PortableDatabase } from "./open.js";
import { query } from "./schema.js";

type Problem = { where: string; error: string };

/**
 * A portable snapshot as a `Vault`: `metadata` as the file states it;
 * `events` scanning the immutable event set in canonical order, its
 * damage reported and its `conflicting` empty, since no diagnostic
 * travels; `objects` under the ordinary read and damage rules. It has
 * no author, no positions and no change frontier, so `changes` is
 * refused, and `commit` with it, neither consuming a source nor
 * minting anything. `check` is asked before every read: what the
 * owner throws once the snapshot is closed.
 */
export class PortableVault implements Vault {
  readonly events: VaultEvents;
  readonly objects: VaultObjects;

  constructor(driver: SqliteDriver, readonly metadata: VaultMetadata, check: () => void) {
    const objects = new SqliteObjectStore({ driver, writable: false });
    const scan = (filter?: Filter): Event[] => {
      const { conditions, bound } = eventFilterSql(filter);
      const events: Event[] = [];
      readEventRows(driver, `SELECT ${EVENT_COLUMNS} FROM events e${conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`} ORDER BY e.at, e.event_id, e.author`, bound, (decoded) => {
        if ("event" in decoded && matches(decoded.event, filter)) events.push(decoded.event);
      });
      return events;
    };
    this.events = {
      scan: async function* (filter) {
        check();
        yield* scan(filter);
      },
      changes: () => Promise.reject(new UnsupportedOperation("changes over a portable snapshot, which has no change frontier")),
      damaged: async () => {
        check();
        const out: Damaged[] = [];
        readEventRows(driver, `SELECT ${EVENT_COLUMNS} FROM events e ORDER BY e.rowid`, [], (decoded) => {
          if ("damage" in decoded) out.push(decoded.damage);
        });
        return out;
      },
      conflicting: async () => {
        check();
        return [];
      },
    };
    this.objects = {
      open: async (cid) => {
        check();
        return objects.open(cid);
      },
      read: async (cid, maxBytes) => {
        check();
        return objects.read(cid, maxBytes);
      },
      stat: async (cid) => {
        check();
        return objects.stat(cid);
      },
      has: async (cid) => {
        check();
        return objects.has(cid);
      },
      list: async function* () {
        check();
        yield* objects.list();
      },
    };
  }

  commit(): Promise<never> {
    return Promise.reject(new UnsupportedOperation("commit over a portable snapshot"));
  }
}

export interface ValidateOptions {
  /** The roots the snapshot's events hold, folded by the caller from the snapshot's own `vault`: the object set must be exactly these. */
  heldRoots: HeldRoots;
  /** The most bytes of events and objects together the validation will read; a snapshot holding more is refused with `SnapshotTooLarge` before a byte of either is read. Unbounded when left out. */
  maxBytes?: number;
}

/** What a validated snapshot holds: its events and their canonical bytes in all, its objects and their bytes in all. */
export interface Validated {
  events: number;
  eventBytes: number;
  objects: number;
  objectBytes: number;
}

/**
 * Checks that the open snapshot `portable` is a complete, sound
 * version-3 snapshot, and says what it holds; `InvalidSnapshot`
 * naming every problem found otherwise. In order: SQLite's foreign-key
 * check; the bytes the tables declare, from their lengths alone — the
 * chunks holding no more than the objects declare, events and objects
 * together within `maxBytes`; SQLite's integrity check, which nothing
 * is read past when it fails; every event row decoding to the event
 * its columns name; every `objects` row keyed by a CID with a size
 * that is a count; the object set equal to `heldRoots` of the events,
 * folded by the caller; and every object's chunks read through,
 * contiguous and of the format's lengths, and hashing to the CID. What
 * SQLite itself cannot read is a problem like the others. Nothing is
 * written.
 */
export async function validatePortable(portable: PortableDatabase, options: ValidateOptions): Promise<Validated> {
  try {
    return await validate(portable, options);
  } catch (err) {
    if (err instanceof SqliteError || err instanceof InvalidSqlValue) throw new InvalidSnapshot([{ where: "database", error: err.message }]);
    throw err;
  }
}

async function validate(portable: PortableDatabase, options: ValidateOptions): Promise<Validated> {
  const { driver, vault } = portable;
  const problems: Problem[] = [];
  for (const row of query(driver, "PRAGMA foreign_key_check")) {
    problems.push({ where: `${String(row["table"])}/rowid ${String(row["rowid"])}`, error: `references a row ${String(row["parent"])} does not have` });
  }
  if (problems.length > 0) throw new InvalidSnapshot(problems);
  const declared = declaredBytes(driver);
  if (declared.chunks > declared.objects) throw new InvalidSnapshot([{ where: "object_chunks", error: `hold ${declared.chunks} bytes where the objects declare ${declared.objects}` }]);
  if (options.maxBytes !== undefined && declared.events + declared.objects > options.maxBytes) throw new SnapshotTooLarge(options.maxBytes, declared.events + declared.objects);
  const integrity = query(driver, "PRAGMA integrity_check").map((row) => String(row["integrity_check"]));
  if (integrity.length !== 1 || integrity[0] !== "ok") throw new InvalidSnapshot([{ where: "database", error: `integrity_check: ${integrity.join("; ")}` }]);
  for (const damage of await vault.events.damaged()) problems.push({ where: damage.where, error: damage.error });
  const listed = new Map<Cid, number>();
  for (const row of query(driver, "SELECT rowid AS rowid, CAST(cid AS BLOB) AS cid, CAST(size AS TEXT) AS size FROM objects")) {
    const where = `objects/rowid ${String(row["rowid"])}`;
    let cid: Cid;
    try {
      cid = rawCidOf(decodeText(row["cid"] as Uint8Array, "objects.cid")).text as Cid;
    } catch (err) {
      problems.push({ where, error: `the key is not a CID: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const size = row["size"];
    if (typeof size !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(size) || !Number.isSafeInteger(Number(size))) {
      problems.push({ where: `objects/${cid}`, error: `size ${String(size)} is not a count` });
      continue;
    }
    listed.set(cid, Number(size));
  }
  if (problems.length > 0) throw new InvalidSnapshot(problems);
  const held = new Set(sortCids(checkedCids(await options.heldRoots(vault))));
  for (const cid of listed.keys()) {
    if (!held.has(cid)) problems.push({ where: `objects/${cid}`, error: "not held by any event of the snapshot" });
  }
  for (const cid of held) {
    if (!listed.has(cid)) problems.push({ where: `objects/${cid}`, error: "held by the events but not in the snapshot" });
  }
  // Read through a store of this call's own: what it found wrong with an object is then reported, not only that a read failed.
  const objects = new SqliteObjectStore({ driver, writable: false });
  for (const cid of listed.keys()) {
    if (!held.has(cid)) continue;
    try {
      const stream = await objects.open(cid);
      if (stream === null) throw new Error("the row is gone");
      for await (const chunk of chunksOf(stream)) void chunk;
    } catch (err) {
      if (!(err instanceof DamagedObject)) problems.push({ where: `objects/${cid}`, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const damage of await objects.damaged()) problems.push({ where: damage.where, error: damage.error });
  if (problems.length > 0) throw new InvalidSnapshot(problems);
  const [counted] = query(driver, "SELECT count(*) AS n FROM events");
  return { events: Number(counted?.["n"]), eventBytes: declared.events, objects: listed.size, objectBytes: declared.objects };
}

/**
 * The bytes the tables declare — canonical event bytes, object sizes,
 * chunk bytes — read from the record headers alone, which is what
 * `length()` of a BLOB column costs: what a bound is checked against
 * before any of them is loaded.
 */
function declaredBytes(driver: SqliteDriver): { events: number; objects: number; chunks: number } {
  const [row] = query(
    driver,
    "SELECT (SELECT coalesce(sum(length(canonical)), 0) FROM events) AS events, (SELECT coalesce(sum(size), 0) FROM objects) AS objects, (SELECT coalesce(sum(length(bytes)), 0) FROM object_chunks) AS chunks"
  );
  const counted = (name: string): number => {
    const value = row?.[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new InvalidSnapshot([{ where: name, error: `declare ${String(value)} bytes, which is not a count` }]);
    return value;
  };
  return { events: counted("events"), objects: counted("objects"), chunks: counted("chunks") };
}

export function checkedCids(cids: Iterable<Cid>): Cid[] {
  const out: Cid[] = [];
  for (const cid of cids) out.push(rawCidOf(cid).text as Cid);
  return out;
}
