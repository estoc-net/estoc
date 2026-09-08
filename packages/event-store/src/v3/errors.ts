/**
 * What the version-3 event model throws. Each names the rule it stands
 * for; a store above wraps or reports them, never reinterprets.
 */

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

/** An accepted object whose bytes no longer hash to its CID, found by a read: the stream fails, and the object leaves the accepted namespace. */
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

/**
 * A structural root of the folder that is not what the layout requires
 * — a file where `events/` belongs — met by a write: nothing was
 * written. A read reports the same as `Damaged` at `where`.
 */
export class DamagedLayout extends Error {
  constructor(
    readonly where: string,
    message: string
  ) {
    super(`${where}: ${message}`);
    this.name = "DamagedLayout";
  }
}

/** The folder is not a version-3 vault this reader opens: no `config.json`, another format or version, a member the closed set does not have, a keystore of another shape. Nothing was written. */
export class NotAVault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAVault";
  }
}

/** The seed in hand does not derive this vault's anchor DID: the wrong seed for this vault. Refused before ownership is taken or any local state made. */
export class AnchorMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly derived: string
  ) {
    super(`the seed derives ${derived}, not this vault's anchor ${expected}: wrong seed for this vault`);
    this.name = "AnchorMismatch";
  }
}

/**
 * `import/` holds recovery state: an import this backend has not
 * finished or cannot recognize. A writable open is blocked until it is
 * completed or rolled back; a read-only open reports it rather than
 * present what `events/` and `objects/` hold as a complete vault.
 * `entries` names what stands under `import/`.
 */
export class PendingImport extends Error {
  constructor(readonly entries: string[]) {
    super(`import/ holds recovery state (${entries.join(", ")}): the import must be completed or rolled back before the vault is opened`);
    this.name = "PendingImport";
  }
}

/** A write on a vault opened read-only: nothing was written. */
export class ReadOnlyVault extends Error {
  constructor(what: string) {
    super(`${what}: the vault is open read-only`);
    this.name = "ReadOnlyVault";
  }
}

/** An object stream asked of a read-only open that holds no ownership: refused rather than served unprotected against a collector. */
export class Unprotected extends Error {
  constructor(readonly cid: string) {
    super(`${cid}: a read-only open without ownership serves no object stream; open with ownership, or through the writer's broker`);
    this.name = "Unprotected";
  }
}

/** An operation on a vault after `close`: ownership is released, and another process may hold the folder by now. */
export class VaultClosed extends Error {
  constructor() {
    super("the vault is closed");
    this.name = "VaultClosed";
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

function describe(problems: { where: string; error: string }[]): string {
  const shown = problems.slice(0, 3).map((p) => `${p.where}: ${p.error}`);
  return problems.length > 3 ? `${shown.join("; ")}; and ${problems.length - 3} more` : shown.join("; ");
}
