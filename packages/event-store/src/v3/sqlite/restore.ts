/**
 * A portable snapshot restored into a new runtime: a fresh database
 * laid with the runtime's own schema and filled with the snapshot's
 * validated values — never its pages, never its SQL — under a fresh
 * replica identity, and opened.
 */

import { v7 } from "uuid";

import { AnchorMismatch, InvalidSnapshot } from "../errors.js";
import { canonicalEventBytes, type AuthorId, type Cid, type Event } from "../event.js";
import type { WrappedSeed } from "../keystore.js";
import type { HeldRoots } from "../vault.js";
import type { SqliteDriver } from "./driver.js";
import { copyObjects, type CopiedObject, type OpenDestination } from "./export.js";
import { CHUNK_BYTES } from "./objects.js";
import { publishedRuntime, type PortableDatabase, type RuntimeDatabase } from "./open.js";
import { validatePortable, type Validated } from "./portable.js";
import { APPLICATION_ID, SCHEMA_VERSION, createTables, query, run } from "./schema.js";

export interface RestoreOptions {
  /** The roots the snapshot's events hold, folded by the caller from the snapshot's own `vault`: what validation requires the object set to be exactly. */
  heldRoots: HeldRoots;
  /**
   * The anchor DID the recovery credential derives: given outright when
   * the seed is in hand, or as the function that unlocks the snapshot's
   * wrapper and derives it — a wrong passphrase fails there. Compared
   * with the snapshot's own anchor before the destination is made:
   * `AnchorMismatch` otherwise. Asked only of a snapshot found complete.
   */
  anchor: string | ((wrapped: WrappedSeed) => string | Promise<string>);
}

/** What a restore made: the runtime, open on the destination, and what the snapshot held. */
export interface Restored extends Validated {
  runtime: RuntimeDatabase;
}

const FORMAT = "estoc-sqlite";
const VAULT_VERSION = 3;

/**
 * Restores `source`, a portable snapshot open read-only, into the
 * runtime `open` creates. First the snapshot is validated in full and
 * the credential's anchor compared with its own, nothing made on a
 * failure of either; then the destination is created — a target
 * nothing is at yet — and laid in one transaction as a runtime with
 * `ready = 0`: the schema, the metadata, the snapshot's wrapper
 * adopted, a fresh replica ID and store generation, and every event
 * with a fresh position in canonical order. Every held object is then
 * streamed through the snapshot's own read, hashed again and written
 * in transactions of its own; the destination is checked against what
 * validation counted and set ready in one transaction; and the
 * runtime is returned open, on the same connection, for the host to
 * reconstruct what the events say is unfinished before it runs. A
 * failure after the destination was made closes it and leaves it
 * unready, for the caller to remove: it opens as nothing, and no seed
 * was minted for it.
 */
export async function restoreVault(source: PortableDatabase, open: OpenDestination, options: RestoreOptions): Promise<Restored> {
  const validated = await validatePortable(source, { heldRoots: options.heldRoots });
  const derived = typeof options.anchor === "string" ? options.anchor : await options.anchor(source.wrapped);
  if (derived !== source.metadata.anchor) throw new AnchorMismatch(source.metadata.anchor, derived);
  const events: Event[] = [];
  for await (const event of source.vault.events.scan()) events.push(event);
  const objects: CopiedObject[] = [];
  for await (const cid of source.vault.objects.list()) objects.push({ cid, size: await sizeOf(source, cid) });
  const writer = await open("create");
  try {
    if (writer.mode !== "create") throw new TypeError(`the destination was opened ${writer.mode}, not to create`);
    if (Number(query(writer, "SELECT count(*) AS n FROM sqlite_master")[0]?.["n"]) > 0) throw new Error("a runtime is restored into an empty database: this one already has a schema");
    const control = { author: v7() as AuthorId, generation: v7() };
    lay(writer, source, control, events);
    await copyObjects(writer, source.vault, objects, (problem) => new InvalidSnapshot([problem]));
    publish(writer, validated, objects);
    return { runtime: publishedRuntime(writer, source.metadata, control), ...validated };
  } catch (err) {
    writer.close();
    throw err;
  }
}

async function sizeOf(source: PortableDatabase, cid: Cid): Promise<number> {
  const info = await source.vault.objects.stat(cid);
  if (info === null) throw new InvalidSnapshot([{ where: `objects/${cid}`, error: "gone between the snapshot's listing and its reading" }]);
  return info.size;
}

/** The destination as a runtime, not yet ready: the schema, the metadata, the wrapper, fresh control, and every event under a fresh position in canonical order, in one transaction. */
function lay(writer: SqliteDriver, source: PortableDatabase, control: { author: AuthorId; generation: string }, events: Event[]): void {
  writer.transaction("immediate", () => {
    writer.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`);
    createTables(writer, "runtime");
    run(writer, "INSERT INTO vault_meta (singleton, format, vault_version, kind, ready, anchor) VALUES (1, ?, ?, 'runtime', 0, ?)", FORMAT, VAULT_VERSION, source.metadata.anchor);
    run(writer, "INSERT INTO keystore (singleton, version, seed_jwe) VALUES (1, 3, ?)", new TextEncoder().encode(source.wrapped.seedJwe));
    run(writer, "INSERT INTO store_state (singleton, replica_id, store_generation, last_seq) VALUES (1, ?, ?, ?)", control.author, control.generation, events.length);
    const insertEvent = writer.prepare("INSERT INTO events (event_id, at, author, type, canonical) VALUES (?, ?, ?, CAST(? AS TEXT), ?)");
    const insertPosition = writer.prepare("INSERT INTO event_positions (accepted_seq, event_id) VALUES (?, ?)");
    try {
      events.forEach((event, i) => {
        insertEvent.run(event.eventId, event.at, event.author, new TextEncoder().encode(event.type), canonicalEventBytes(event));
        insertPosition.run(i + 1, event.eventId);
      });
    } finally {
      insertEvent.finalize();
      insertPosition.finalize();
    }
  });
}

/** The destination checked against what validation counted in the snapshot — events and their bytes, positions, objects, bytes and chunks — and set ready, in one transaction. */
function publish(writer: SqliteDriver, validated: Validated, objects: CopiedObject[]): void {
  const expected = {
    events: validated.events,
    eventBytes: validated.eventBytes,
    positions: validated.events,
    lastSeq: validated.events,
    objects: validated.objects,
    bytes: validated.objectBytes,
    chunks: objects.reduce((n, object) => n + Math.ceil(object.size / CHUNK_BYTES), 0),
  };
  writer.transaction("immediate", () => {
    const [row] = query(
      writer,
      "SELECT (SELECT count(*) FROM events) AS events, (SELECT coalesce(sum(length(canonical)), 0) FROM events) AS event_bytes, (SELECT count(*) FROM event_positions) AS positions, (SELECT last_seq FROM store_state) AS last_seq, (SELECT count(*) FROM objects) AS objects, (SELECT coalesce(sum(size), 0) FROM objects) AS bytes, (SELECT count(*) FROM object_chunks) AS chunks"
    );
    const laid = {
      events: Number(row?.["events"]),
      eventBytes: Number(row?.["event_bytes"]),
      positions: Number(row?.["positions"]),
      lastSeq: Number(row?.["last_seq"]),
      objects: Number(row?.["objects"]),
      bytes: Number(row?.["bytes"]),
      chunks: Number(row?.["chunks"]),
    };
    if (JSON.stringify(laid) !== JSON.stringify(expected)) throw new Error(`the destination holds ${JSON.stringify(laid)} where the snapshot has ${JSON.stringify(expected)}`);
    if (run(writer, "UPDATE vault_meta SET ready = 1 WHERE singleton = 1") !== 1) throw new Error("the metadata row is gone");
  });
}
