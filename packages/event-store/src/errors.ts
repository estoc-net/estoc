import type { Event } from "./event.js";

/** A value that is not an event (event-store.md §2.4) or a draft that cannot become one. */
export class InvalidEvent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEvent";
  }
}

/**
 * `ingest` met an event authored by `self` that this store does not hold
 * (§4.2): two writers have shared one device. Nothing was written; the
 * person decides, usually by minting a fresh device and importing again.
 */
export class ForkedSelf extends Error {
  constructor(
    readonly self: string,
    readonly events: Event[]
  ) {
    super(`${events.length} event(s) authored by this device (${self}) are not in this store`);
    this.name = "ForkedSelf";
  }
}

/** A `ChangeToken` this store instance cannot place (§4.4): refold from `scan`. */
export class BadToken extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadToken";
  }
}

/** A block that is not what its name says (§5.1): never stored, never served. */
export class BadBlock extends Error {
  constructor(
    readonly cid: string,
    message: string
  ) {
    super(`${cid}: ${message}`);
    this.name = "BadBlock";
  }
}

/** `BlobStore.get` was asked for a root that names a directory or shard, not a file. */
export class NotAFile extends Error {
  constructor(readonly cid: string) {
    super(`${cid} is not a file`);
    this.name = "NotAFile";
  }
}

/** A handle to an extension store this instance disposed of (§8): every method rejects, for good. */
export class Disposed extends Error {
  constructor(readonly ext: string) {
    super(`extension store ${ext} was disposed of`);
    this.name = "Disposed";
  }
}

/** The folder is not a version-2 vault (vault-folder.md §11): nothing was read past `config.json`, nothing written. */
export class NotAVault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAVault";
  }
}

/**
 * The source of a merge is another vault (vault-folder.md §6.1): its
 * `config.json` — format, version, anchor — is not this one's. Nothing
 * was written; two identities are two vaults.
 */
export class NotSameVault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSameVault";
  }
}
