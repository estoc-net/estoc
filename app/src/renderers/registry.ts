import type { Component } from "vue";

import type { Entry } from "../core/entries.js";

/**
 * How a message type is drawn. The thread walks its entries and hands each
 * to the renderer registered for its type; a type nobody registered gets
 * the generic one, which shows that something arrived and what it said.
 *
 * A renderer is a seam, not a plugin system: first-party renderers run in
 * process, and the only thing they are given is the entry (and the contact
 * it belongs to) through props — never the store. That is what keeps the
 * door open to running a renderer somewhere else later (a sandboxed frame,
 * a renderer that came in the vault) without rewriting the thread.
 */
export interface MessageRenderer {
  /** the message type URIs this draws */
  types: string[];
  /** the component: takes `entry: Entry` and `contact: Contact | null` */
  component: Component;
  /**
   * Whether the entry takes a place in the thread at all. Everything
   * between contacts is in the log; not everything is worth a line on
   * screen — a heartbeat is not. Default: shown.
   */
  shows?(entry: Entry): boolean;
}

const byType = new Map<string, MessageRenderer>();
let fallback: MessageRenderer | null = null;

/** Register a renderer for its types; a later registration for a type replaces the earlier. */
export function registerRenderer(renderer: MessageRenderer): void {
  for (const type of renderer.types) {
    byType.set(type, renderer);
  }
}

/** The renderer for types nobody registered. */
export function registerFallback(renderer: MessageRenderer): void {
  fallback = renderer;
}

export function rendererFor(type: string): MessageRenderer {
  const renderer = byType.get(type) ?? fallback;
  if (renderer === null || renderer === undefined) {
    throw new Error("no renderer registered, not even a fallback");
  }
  return renderer;
}

export function showsInThread(entry: Entry): boolean {
  const renderer = rendererFor(entry.type);
  return renderer.shows === undefined ? true : renderer.shows(entry);
}
