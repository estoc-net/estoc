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
 * The UUIDv7 allocator cannot mint the IDs asked of it within the
 * sampled millisecond (event-store.md §4.2): the counter would overflow.
 * Nothing was allocated; the append or batch fails before it commits.
 * The allocator neither wraps nor moves the embedded timestamp forward.
 */
export class CounterExhausted extends Error {
  constructor(
    readonly t: number,
    readonly requested: number,
    readonly room: number
  ) {
    super(`cannot mint ${requested} UUIDv7 at t=${t}: ${room} left in the counter`);
    this.name = "CounterExhausted";
  }
}
