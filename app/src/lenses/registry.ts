import type { Component } from "vue";

import type { TraceEvent, TraceLevel } from "@estoc/vault";

import type { Entry } from "../core/entries.js";

/**
 * A lens is the other axis of looking at a record. A renderer
 * (src/renderers) is chosen by message type and shows what the message
 * says; a lens can be opened on any entry whatever its type, and shows
 * something *about* it — the onion of envelopes it crossed, say — from
 * the vault's trace rather than from the message.
 *
 * The seam is the same shape as a renderer's: a lens gets the entry and
 * the trace events that ended in it, through props, and nothing else —
 * never the store, never the vault. The host (the bubble) fetches the
 * events over the daemon and hands them in; that is what a third-party
 * lens in a sandboxed frame would be fed too.
 */
export interface Lens {
  id: string;
  /** the word on the entry point, e.g. "peel" */
  label: string;
  /** the component: takes `entry: Entry` and `events: TraceEvent[]` */
  component: Component;
  /** whether this lens has anything to say here — the entry point appears only when it does */
  available(entry: Entry, context: LensContext): boolean;
}

export interface LensContext {
  /** what this device keeps of what it observes; `off` means there is no trace to read */
  traceLevel: TraceLevel;
}

export type { TraceEvent };

const lenses: Lens[] = [];

/** Register a lens; a later registration of the same id replaces the earlier. */
export function registerLens(lens: Lens): void {
  const index = lenses.findIndex((l) => l.id === lens.id);
  if (index === -1) {
    lenses.push(lens);
  } else {
    lenses[index] = lens;
  }
}

export function lensesFor(entry: Entry, context: LensContext): Lens[] {
  return lenses.filter((l) => l.available(entry, context));
}
