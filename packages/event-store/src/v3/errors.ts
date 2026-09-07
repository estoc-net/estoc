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
