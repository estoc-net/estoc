/**
 * What the version-3 event model throws. Each names the rule it stands
 * for; a store above wraps or reports them, never reinterprets.
 */

/**
 * Text that is not I-JSON, or a value that cannot be serialized under
 * RFC 8785 (event-store.md §3.3): a duplicate member, an unpaired
 * surrogate, a non-finite number, `undefined`, a bigint, a host object,
 * a cycle, or plain bad syntax.
 */
export class InvalidJson extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJson";
  }
}

/** A value that fails envelope validation (event-store.md §3.4), or a draft that cannot become an event. */
export class InvalidEvent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEvent";
  }
}

/**
 * `ingest` met an event authored by this store's own author that it does
 * not already hold with identical content (event-store.md §5.3): two
 * writable copies have shared one replica ID. Nothing was added; the
 * recovery is operational — close, mint a fresh author and generation,
 * reopen, ingest again.
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

/** A `ChangeToken` this store generation cannot place (event-store.md §5.5): discard the cache, refold from `scan`. */
export class BadToken extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadToken";
  }
}

/** A string that is not a canonical raw DASL CID (dasl-objects.md §3): the wrong version, codec, hash, digest length or spelling. Every store method checks its CID arguments first. */
export class InvalidCid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCid";
  }
}

/** `putObject` streamed bytes that do not hash to the CID it was given (dasl-objects.md §6.2): nothing was accepted. */
export class DigestMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(`bytes hash to ${actual}, not ${expected}`);
    this.name = "DigestMismatch";
  }
}

/** An object over the store's accepted-size bound, or a `read` whose object is larger than `maxBytes` (dasl-objects.md §6.3, §12): an error, never a truncation. */
export class ObjectTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectTooLarge";
  }
}

/** An accepted object whose bytes no longer hash to its CID, found by a read (dasl-objects.md §8.2, DO-16): the stream fails, and the object leaves the accepted namespace. */
export class DamagedObject extends Error {
  constructor(readonly cid: string) {
    super(`the bytes held for ${cid} no longer hash to it`);
    this.name = "DamagedObject";
  }
}

/** A draft root `commit` was given that names no present accepted object (event-store.md §10, DO-8): nothing was appended. */
export class MissingRoot extends Error {
  constructor(readonly cid: string) {
    super(`root ${cid} is not a present accepted object`);
    this.name = "MissingRoot";
  }
}
