/**
 * What the version-3 event model throws. Each names the rule it stands
 * for; a store above wraps or reports them, never reinterprets.
 */

import type { Damaged } from "./event.js";

/**
 * Text that is not I-JSON, or a value that cannot be serialized under
 * RFC 8785: a duplicate member, an unpaired surrogate, a non-finite
 * number, `undefined`, a bigint, a host object, a cycle, or plain bad
 * syntax.
 */
export class InvalidJson extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJson";
  }
}

/** A value that fails envelope validation, or a draft that cannot become an event. */
export class InvalidEvent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEvent";
  }
}

/**
 * `ingest` met an event authored by this store's own author that it does
 * not already hold with identical content: two writable copies have
 * shared one replica ID. Nothing was added; the recovery is operational
 * — close, mint a fresh author and generation, reopen, ingest again.
 */
export class ForkedAuthor extends Error {
  constructor(
    readonly author: string,
    readonly events: unknown[]
  ) {
    super(`${events.length} event(s) authored by this replica (${author}) are not in this store`);
    this.name = "ForkedAuthor";
  }
}

/** A `ChangeToken` this store generation cannot place: discard the cache, refold from `scan`. */
export class BadToken extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadToken";
  }
}

/** A string that is not a canonical raw DASL CID: the wrong version, codec, hash, digest length or spelling. Every store method checks its CID arguments first. */
export class InvalidCid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCid";
  }
}

/** `putObject` streamed bytes that do not hash to the CID it was given: nothing was accepted. */
export class DigestMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(`bytes hash to ${actual}, not ${expected}`);
    this.name = "DigestMismatch";
  }
}

/** An object over the store's accepted-size bound, or a `read` whose object is larger than `maxBytes`: an error, never a truncation. */
export class ObjectTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectTooLarge";
  }
}

/**
 * An accepted object whose bytes no longer hash to its CID. The read
 * that finds it fails; from then on, for as long as the store is open,
 * `has`, `stat`, `open` and `read` of that CID fail the same way and
 * `list` fails on reaching it — absence is never how damage shows. The
 * bytes stay where they are until a put of the same CID replaces them
 * with verified ones, or collection removes them.
 */
export class DamagedObject extends Error {
  constructor(readonly cid: string) {
    super(`the bytes held for ${cid} no longer hash to it`);
    this.name = "DamagedObject";
  }
}

/** A draft root `commit` was given that names no present accepted object: nothing was appended. */
export class MissingRoot extends Error {
  constructor(readonly cid: string) {
    super(`root ${cid} is not a present accepted object`);
    this.name = "MissingRoot";
  }
}

/** An object handed to `commit` that no draft of the batch names as a root: refused before its bytes are read, and nothing of the batch was accepted. */
export class UnreferencedObject extends Error {
  constructor(readonly cid: string) {
    super(`object ${cid} is not a root of any draft in the batch: a commit accepts only what its events reference`);
    this.name = "UnreferencedObject";
  }
}

/** An operation the view in hand does not do — a write asked of the read-only view of a snapshot, a mutation asked inside a keep callback or after the operation holding the view has returned, any call through a held view whose operation has ended — refused before consuming a source or minting anything. */
export class UnsupportedOperation extends Error {
  constructor(what: string) {
    super(`${what}: not supported by this vault`);
    this.name = "UnsupportedOperation";
  }
}

/** What was opened is not a version-3 vault this reader opens: another format or version, missing or malformed metadata, a keystore of another shape. Nothing was written. */
export class NotAVault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAVault";
  }
}

/**
 * Another anchor DID than this vault's: the seed in hand does not derive
 * it — the wrong seed for this vault — or, for an import, the source
 * snapshot is another vault's.
 */
export class AnchorMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly derived: string,
    of: "seed" | "source" = "seed"
  ) {
    super(
      of === "seed"
        ? `the seed derives ${derived}, not this vault's anchor ${expected}: wrong seed for this vault`
        : `the source's anchor is ${derived}, not this vault's ${expected}: another vault's snapshot is not imported into this one`
    );
    this.name = "AnchorMismatch";
  }
}

/**
 * A runtime whose local control — the replica ID, the store generation,
 * the positions every accepted event has — is missing or does not
 * account for its events. The vault is not opened and nothing is made
 * up in its place: its history is recovered by restoring a snapshot
 * into a new runtime.
 */
export class DamagedControl extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DamagedControl";
  }
}

/**
 * A write refused because an accepted event no longer decodes to what
 * its row names: the history is incomplete, and a vault does not
 * build on it — no event is accepted, published or collected until a
 * validated snapshot is restored into a new runtime. Reads still work,
 * and `damaged()` lists what was found.
 */
export class DamagedHistory extends Error {
  constructor(readonly damage: Damaged) {
    super(`${damage.where} is damaged, ${damage.error}: the history is incomplete and the vault accepts no write until a validated snapshot is restored into a new runtime`);
    this.name = "DamagedHistory";
  }
}

/** A write on a vault opened read-only: nothing was written. */
export class ReadOnlyVault extends Error {
  constructor(what: string) {
    super(`${what}: the vault is open read-only`);
    this.name = "ReadOnlyVault";
  }
}

/** An operation on a vault after `close`: ownership is released, and another process may hold the vault by now. */
export class VaultClosed extends Error {
  constructor() {
    super("the vault is closed");
    this.name = "VaultClosed";
  }
}

/**
 * A value the SQLite driver cannot carry exactly, refused before the
 * statement runs: an integer outside the safe range, a non-finite
 * number, a bigint, a boolean, `undefined`, an object, a string with a
 * NUL or an unpaired surrogate; or a stored integer outside the safe
 * range, refused on read rather than rounded.
 */
export class InvalidSqlValue extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSqlValue";
  }
}

/**
 * What SQLite itself refused or could not do — a constraint, a strict
 * type, a read-only database, an I/O error — as one class on every
 * platform, with SQLite's result code (the extended one where the
 * platform reports it). A store above decides what it means; the
 * driver only carries it.
 */
export class SqliteError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
    this.name = "SqliteError";
  }
}

/** Another connection holds the database open — this process, another process, another worker — and this open was refused: ownership is one connection at a time. */
export class DatabaseBusy extends Error {
  constructor(readonly target: string) {
    super(`${target}: another connection holds this database open`);
    this.name = "DatabaseBusy";
  }
}

/** A `create` open whose target already exists: a create never overwrites, and an open never creates. */
export class DatabaseExists extends Error {
  constructor(readonly target: string) {
    super(`${target}: already exists; create refuses an existing target`);
    this.name = "DatabaseExists";
  }
}

/** A `readwrite` or `readonly` open whose target does not exist: an open never creates. */
export class DatabaseMissing extends Error {
  constructor(readonly target: string) {
    super(`${target}: no database there; open never creates one`);
    this.name = "DatabaseMissing";
  }
}

/** A call on a driver connection after `close`: its statements are finalized and its ownership released. */
export class DatabaseClosed extends Error {
  constructor() {
    super("the database connection is closed");
    this.name = "DatabaseClosed";
  }
}

/** An export could not select a complete cut: damage or a conflict in the event set, or a held root missing or damaged; nothing was published. */
export class IncompleteSnapshot extends Error {
  constructor(readonly problems: { where: string; error: string }[]) {
    super(`the export is incomplete and was not published: ${describe(problems)}`);
    this.name = "IncompleteSnapshot";
  }
}

/** A restore's source is not a valid version-3 snapshot; nothing was published. */
export class InvalidSnapshot extends Error {
  constructor(readonly problems: { where: string; error: string }[]) {
    super(`not a valid snapshot: ${describe(problems)}`);
    this.name = "InvalidSnapshot";
  }
}

/**
 * An import could not make a complete merged view: damage or a conflict
 * in the target's event set, a root the merged set requires with valid
 * bytes in neither the source nor the target, or a source object whose
 * bytes do not spell its name. Nothing was published.
 */
export class IncompleteImport extends Error {
  constructor(readonly problems: { where: string; error: string }[]) {
    super(`the import is incomplete and was not published: ${describe(problems)}`);
    this.name = "IncompleteImport";
  }
}

function describe(problems: { where: string; error: string }[]): string {
  const shown = problems.slice(0, 3).map((p) => `${p.where}: ${p.error}`);
  return problems.length > 3 ? `${shown.join("; ")}; and ${problems.length - 3} more` : shown.join("; ");
}
