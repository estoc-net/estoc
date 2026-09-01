/**
 * The event set a fold reads (vault-events.md §7): every event once, by
 * eid, in whatever order it came; the vault's own types read, the rest
 * kept for their `blobs` (§8.3). Order-free by construction — a fold asks
 * for a type's events sorted, and canonical order (event-store.md §3) is
 * a property of the events, not of their arrival.
 */

import type { Cid, Event } from "@estoc/event-store";
import { compareEvents } from "@estoc/event-store";

import { Malformed, readVaultEvent, type VaultEvent, type VaultType } from "./types.js";

export class EventSet {
  private readonly held = new Map<string, VaultEvent>();
  /** events of a type this document does not name, and malformed ones: their roots are held for the vault's life (§8.3) */
  private readonly others = new Map<string, Event>();
  private readonly byType = new Map<VaultType, VaultEvent[]>();
  private readonly sorted = new Map<VaultType, VaultEvent[]>();
  /** lines of a vault type whose `data` is not what the type says: for the caller to surface */
  readonly malformed: Malformed[] = [];

  /** Add one event; false if the set already held its eid. */
  add(event: Event): boolean {
    if (this.held.has(event.eid) || this.others.has(event.eid)) {
      return false;
    }
    let read: VaultEvent | null;
    try {
      read = readVaultEvent(event);
    } catch (err) {
      if (!(err instanceof Malformed)) {
        throw err;
      }
      this.malformed.push(err);
      this.others.set(event.eid, event);
      return true;
    }
    if (read === null) {
      this.others.set(event.eid, event);
      return true;
    }
    this.held.set(event.eid, read);
    const list = this.byType.get(read.type);
    if (list === undefined) {
      this.byType.set(read.type, [read]);
    } else {
      list.push(read);
    }
    this.sorted.delete(read.type);
    return true;
  }

  get size(): number {
    return this.held.size + this.others.size;
  }

  /** Every event of `type`, in canonical order. */
  of<T extends VaultType>(type: T): VaultEvent<T>[] {
    let list = this.sorted.get(type);
    if (list === undefined) {
      list = [...(this.byType.get(type) ?? [])].sort(compareEvents);
      this.sorted.set(type, list);
    }
    return list as VaultEvent<T>[];
  }

  /** The roots every event of a type this document does not name references: held for the vault's life. */
  foreignRoots(): Cid[] {
    const roots = new Set<Cid>();
    for (const event of this.others.values()) {
      for (const root of event.blobs) {
        roots.add(root);
      }
    }
    return [...roots];
  }

  /** Every author seen, on any event. */
  authors(): Set<string> {
    const authors = new Set<string>();
    for (const event of this.held.values()) {
      authors.add(event.author);
    }
    for (const event of this.others.values()) {
      authors.add(event.author);
    }
    return authors;
  }
}

/** The last of `events` in canonical order, or null: what a latest-wins field is (§1 principle 4). */
export function latest<E extends Event>(events: readonly E[]): E | null {
  let best: E | null = null;
  for (const event of events) {
    if (best === null || compareEvents(best, event) < 0) {
      best = event;
    }
  }
  return best;
}

/** Connected components by union-find: an edge in either direction joins. */
export class Components {
  private readonly parent = new Map<string, string>();

  add(node: string): void {
    if (!this.parent.has(node)) {
      this.parent.set(node, node);
    }
  }

  has(node: string): boolean {
    return this.parent.has(node);
  }

  find(node: string): string {
    let root = node;
    let next = this.parent.get(root);
    while (next !== undefined && next !== root) {
      root = next;
      next = this.parent.get(root);
    }
    if (next === undefined) {
      throw new Error(`not a node: ${node}`);
    }
    // path compression
    let cur = node;
    while (cur !== root) {
      const up = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = up;
    }
    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      // the smaller root wins, so that the representative is a function of the set and not of the order
      if (ra < rb) {
        this.parent.set(rb, ra);
      } else {
        this.parent.set(ra, rb);
      }
    }
  }

  /** Every node, grouped by component, each group sorted. */
  groups(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const node of [...this.parent.keys()].sort()) {
      const root = this.find(node);
      const group = groups.get(root);
      if (group === undefined) {
        groups.set(root, [node]);
      } else {
        group.push(node);
      }
    }
    return groups;
  }
}
