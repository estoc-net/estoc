/** One store's writes, one at a time (vault-folder.md §9.2): a promise chain the store's operations queue on. */
export class Serial {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

import type { VaultBackend } from "../backend/types.js";
import { EidMinter } from "../event.js";

/** What one folder store — the vault's or an extension's — is made of. */
export interface StoreContext {
  backend: VaultBackend;
  /** the store's directory, relative to the vault root: `.estoc` or `.estoc/extensions/<ext>` */
  base: string;
  /** where a damaged block is moved aside to (§8) */
  aside: string;
  self: string;
  instance: string;
  /** which store of the instance this is; what its tokens name */
  store: string;
  clock: () => Date;
  serial: Serial;
  /** segment names, monotone */
  segments: EidMinter;
  /** throws once `dispose` has been called on the store (§3.1): checked as an operation is called */
  guard: () => void;
  /** throws once the disposal has run in the store's chain: checked as an operation's turn comes, so what was queued before it finishes */
  alive: () => void;
  /** the writer's own rotation (§5) */
  rotateBytes: number;
  /** bumped by every write that adds events through this instance, so a reader can tell whether what it read is still what is there */
  generation: number;
}
