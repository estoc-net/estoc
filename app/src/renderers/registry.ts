import type { Component } from "vue";

import type { MessageRecord } from "../core/types.js";

/**
 * How a message type is drawn. The thread walks its messages and hands each
 * to the renderer registered for its type; a type nobody registered gets
 * the generic one, which shows that something arrived and what it said.
 *
 * A renderer is a seam, not a plugin system: first-party renderers run in
 * process, and the only thing they are given is the message record through
 * props — never the store. That is what keeps the
 * door open to running a renderer somewhere else later (a sandboxed frame,
 * a renderer that came in the vault) without rewriting the thread.
 */
export interface MessageRenderer {
  /** the message type URIs this draws */
  types: string[];
  /** the component: takes `message: MessageRecord` */
  component: Component;
  /**
   * Whether the message takes a place in the thread at all. Everything
   * between peers is in the vault; not everything is worth a line on
   * screen — a heartbeat is not. One that needs the person is shown
   * whatever this says. Default: shown.
   */
  shows?(message: MessageRecord): boolean;
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

/** The type a record is drawn by: none while its observations, or its intents, do not agree on one. */
export function typeOf(message: MessageRecord): string {
  return message.msg?.type ?? "";
}

/** Whether something about the message is the person's to look at or act on, whatever its type. */
export function needsAttention(message: MessageRecord): boolean {
  return message.manualAction !== "none" || message.diagnostics.length > 0 || message.outcome?.status === "conflict" || message.input?.status === "conflict";
}

/** What the vault sends and receives on its own account: receipts, heartbeat replies, rotation notices. */
function isPlumbing(message: MessageRecord): boolean {
  return message.effectType !== null || message.kind === "pure-ack" || message.kind === "empty" || message.kind === "ping-response";
}

export function showsInThread(message: MessageRecord): boolean {
  if (needsAttention(message)) {
    return true;
  }
  const renderer = rendererFor(typeOf(message));
  return !isPlumbing(message) && (renderer.shows === undefined || renderer.shows(message));
}
