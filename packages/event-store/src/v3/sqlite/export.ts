/**
 * The portable snapshot of a running vault, built into a fresh
 * database — so no page of it ever held what is not in it — and
 * validated as a restore would validate it. Any runtime exports this
 * way, the vault in memory too, since it reads through the interfaces
 * every runtime presents.
 */

import { DamagedObject, IncompleteSnapshot, SnapshotTooLarge } from "../errors.js";
import { canonicalEventBytes, type Cid, type Event } from "../event.js";
import type { WrappedSeed } from "../keystore.js";
import { Packer, hashSource, sortCids } from "../objects.js";
import type { Held, HeldRoots, VaultRuntime } from "../vault.js";
import type { SqliteDriver } from "./driver.js";
import { CHUNK_BYTES } from "./objects.js";
import { openPortable } from "./open.js";
import { checkedCids, validatePortable, type Validated } from "./portable.js";
import { APPLICATION_ID, SCHEMA_VERSION, createTables, query, run } from "./schema.js";

/**
 * Opens the destination: once under the lock to `create` it, a
 * target nothing is at yet, and once after the writer has closed to
 * reopen the completed file `readonly` for validation. The platform's
 * to provide — a path for `node:sqlite`, a name in the pool for
 * wasm — and, once the export returns, the platform's to deliver:
 * the file is complete and validated, and nothing here touches it
 * again. A destination an export failed on is left unready, for the
 * caller to remove.
 */
export type OpenDestination = (mode: "create" | "readonly") => Promise<SqliteDriver> | SqliteDriver;

export interface ExportOptions {
  /** The roots the vault's events hold, folded by the caller under the lock through the held view; what the snapshot carries besides the events. */
  heldRoots: HeldRoots;
  /** The most bytes of events and objects together the export will copy: the events' canonical bytes are tallied from what the store keeps beside them, before one is read, and the objects' sizes from their metadata, before a chunk is; a cut past it is `SnapshotTooLarge`, nothing read further and no destination made. Unbounded when left out. */
  maxBytes?: number;
}

export type Exported = Validated;

const FORMAT = "estoc-sqlite";
const VAULT_VERSION = 3;

/** How many bytes of chunks are gathered from a source stream before a transaction writes them: the memory an export holds beyond the chunk in hand. */
const BATCH_BYTES = 8 * CHUNK_BYTES;

/** One cut of a vault: what the snapshot is built from, read whole under the lock before the destination is opened. */
interface Cut {
  wrapped: WrappedSeed;
  events: Event[];
  eventBytes: number;
  roots: { cid: Cid; size: number }[];
}

/**
 * Exports `runtime` to the destination `open` gives, and validates
 * the file it made. Under the lock: the cut is selected —
 * `SnapshotTooLarge` when the events' tally, before one is read, or
 * the events and the held objects together, before a chunk is, pass
 * `maxBytes`, `IncompleteSnapshot` when the history has damage or a
 * held root is absent or known damaged, nothing made in either case
 * — then the destination is created, laid as a portable database with
 * `ready = 0`, filled, checked against the cut, set ready, and
 * closed. Outside the lock: the file is reopened read-only and
 * validated in full — with no file bound: the file is the one this
 * export just built and closed, and its event and object payload is
 * within `maxBytes` when the caller gave one — and closed. A source
 * that fails while its bytes are copied is `IncompleteSnapshot` too,
 * the destination left unready. A conflict recorded against an event is a
 * local diagnostic, not damage: the accepted value is exported and
 * the diagnostic is not.
 */
export async function exportVault(runtime: VaultRuntime, open: OpenDestination, options: ExportOptions): Promise<Exported> {
  await runtime.locked(async (held) => {
    const cut = await select(runtime, held, options);
    const writer = await open("create");
    try {
      if (writer.mode !== "create") throw new TypeError(`the destination was opened ${writer.mode}, not to create`);
      lay(writer, runtime.metadata.anchor, cut);
      await fill(writer, held, cut.roots);
      publish(writer, cut);
    } finally {
      writer.close();
    }
  });
  const portable = openPortable(await open("readonly"));
  try {
    return await validatePortable(portable, { heldRoots: options.heldRoots });
  } finally {
    portable.close();
  }
}

async function select(runtime: VaultRuntime, held: Held, options: ExportOptions): Promise<Cut> {
  const tallied = await held.tally();
  if (options.maxBytes !== undefined && tallied.bytes > options.maxBytes) throw new SnapshotTooLarge(options.maxBytes, tallied.bytes);
  const problems: { where: string; error: string }[] = [];
  for (const damage of await held.events.damaged()) problems.push({ where: damage.where, error: damage.error });
  if (problems.length > 0) throw new IncompleteSnapshot(problems);
  const wrapped = await runtime.keystore.read();
  const events: Event[] = [];
  let eventBytes = 0;
  for await (const event of held.events.scan()) {
    events.push(event);
    eventBytes += canonicalEventBytes(event).length;
  }
  const roots: Cut["roots"] = [];
  let objectBytes = 0;
  for (const cid of sortCids(checkedCids(await options.heldRoots(held)))) {
    let info;
    try {
      info = await held.objects.stat(cid);
    } catch (err) {
      if (!(err instanceof DamagedObject)) throw err;
      problems.push({ where: `objects/${cid}`, error: err.message });
      continue;
    }
    if (info === null) {
      problems.push({ where: `objects/${cid}`, error: "held by the events but not present" });
      continue;
    }
    roots.push({ cid, size: info.size });
    objectBytes += info.size;
  }
  if (problems.length > 0) throw new IncompleteSnapshot(problems);
  if (options.maxBytes !== undefined && eventBytes + objectBytes > options.maxBytes) throw new SnapshotTooLarge(options.maxBytes, eventBytes + objectBytes);
  return { wrapped, events, eventBytes, roots };
}

/** The destination as a portable database, not yet ready: the schema, the metadata, the wrapper and every event, in one transaction. */
function lay(writer: SqliteDriver, anchor: string, cut: Cut): void {
  if (Number(query(writer, "SELECT count(*) AS n FROM sqlite_master")[0]?.["n"]) > 0) throw new Error("a snapshot is built in an empty database: this one already has a schema");
  const journal = String(query(writer, "PRAGMA journal_mode = DELETE")[0]?.["journal_mode"]);
  if (journal !== "delete") throw new Error(`the destination keeps a ${journal} journal, not the rollback journal a snapshot stands alone with`);
  writer.exec("PRAGMA synchronous = FULL");
  writer.transaction("immediate", () => {
    writer.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`);
    createTables(writer, "portable");
    run(writer, "INSERT INTO vault_meta (singleton, format, vault_version, kind, ready, anchor) VALUES (1, ?, ?, 'portable', 0, ?)", FORMAT, VAULT_VERSION, anchor);
    run(writer, "INSERT INTO keystore (singleton, version, seed_jwe) VALUES (1, 3, ?)", new TextEncoder().encode(cut.wrapped.seedJwe));
    const insert = writer.prepare("INSERT INTO events (event_id, at, author, type, canonical) VALUES (?, ?, ?, CAST(? AS TEXT), ?)");
    try {
      for (const event of cut.events) insert.run(event.eventId, event.at, event.author, new TextEncoder().encode(event.type), canonicalEventBytes(event));
    } finally {
      insert.finalize();
    }
  });
}

/**
 * Every held object copied from the vault into the destination, one
 * at a time: its bytes streamed through the vault's own read — which
 * rehashes them — and hashed again here, cut into the format's chunks
 * and written a batch at a time in transactions of their own, the
 * `objects` row with the first. An object whose bytes fail to read,
 * or hash to something else, is `IncompleteSnapshot`.
 */
async function fill(writer: SqliteDriver, held: Held, roots: Cut["roots"]): Promise<void> {
  const insertObject = writer.prepare("INSERT INTO objects (cid, size) VALUES (?, ?)");
  const insertChunk = writer.prepare("INSERT INTO object_chunks (cid, chunk_no, bytes) VALUES (?, ?, ?)");
  try {
    for (const { cid, size } of roots) {
      let batch: Uint8Array[] = [];
      let batched = 0;
      let chunkNo = 0;
      let rowMade = false;
      const flush = (): void => {
        writer.transaction("immediate", () => {
          if (!rowMade) {
            insertObject.run(cid, size);
            rowMade = true;
          }
          for (const chunk of batch) insertChunk.run(cid, chunkNo++, chunk);
        });
        batch = [];
        batched = 0;
      };
      const packer = new Packer(CHUNK_BYTES, (chunk) => {
        batch.push(chunk);
        batched += chunk.length;
        if (batched >= BATCH_BYTES) flush();
      });
      const fail = (error: string): never => {
        throw new IncompleteSnapshot([{ where: `objects/${cid}`, error }]);
      };
      const stream = await held.objects.open(cid);
      if (stream === null) return fail("held by the events but not present");
      let got: { cid: { text: string }; size: number };
      try {
        got = await hashSource(stream, size, (chunk) => packer.push(chunk));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      packer.finish();
      if (got.cid.text !== cid || got.size !== size) return fail(`the bytes read hash to ${got.cid.text} at ${got.size} bytes, not the object's`);
      flush();
    }
  } finally {
    insertObject.finalize();
    insertChunk.finalize();
  }
}

/** The destination checked against the cut — as many events and their bytes, objects, bytes and chunks as were laid — and set ready, in one transaction. */
function publish(writer: SqliteDriver, cut: Cut): void {
  const expected = {
    events: cut.events.length,
    eventBytes: cut.eventBytes,
    objects: cut.roots.length,
    bytes: cut.roots.reduce((n, root) => n + root.size, 0),
    chunks: cut.roots.reduce((n, root) => n + Math.ceil(root.size / CHUNK_BYTES), 0),
  };
  writer.transaction("immediate", () => {
    const [row] = query(
      writer,
      "SELECT (SELECT count(*) FROM events) AS events, (SELECT coalesce(sum(length(canonical)), 0) FROM events) AS event_bytes, (SELECT count(*) FROM objects) AS objects, (SELECT coalesce(sum(size), 0) FROM objects) AS bytes, (SELECT count(*) FROM object_chunks) AS chunks"
    );
    const laid = { events: Number(row?.["events"]), eventBytes: Number(row?.["event_bytes"]), objects: Number(row?.["objects"]), bytes: Number(row?.["bytes"]), chunks: Number(row?.["chunks"]) };
    if (JSON.stringify(laid) !== JSON.stringify(expected)) throw new Error(`the destination holds ${JSON.stringify(laid)} where the cut has ${JSON.stringify(expected)}`);
    if (run(writer, "UPDATE vault_meta SET ready = 1 WHERE singleton = 1") !== 1) throw new Error("the metadata row is gone");
  });
}
