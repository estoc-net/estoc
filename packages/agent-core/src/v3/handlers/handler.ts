/**
 * The seam for what a protocol answers to an input. The agent's part
 * is the same for every message type and is done before a handler is
 * asked: the input is established in its channel by a complete
 * witness, the channel a reply may go by is selected, the requested
 * receipt is acknowledged under the vault's own policy. A handler adds
 * what its protocol says: the output an input earns, under the fixed
 * effect type of the operation that produces it, with the content the
 * protocol's response rules fix from the source's headers and body. It
 * decides content only. The tuple, the message ID, the channel, the
 * sender and whether an intent already exists under the tuple are the
 * agent's, and a handler cannot move an output to another channel or
 * make a second one for the same operation. A handler reads the fold
 * and writes nothing.
 *
 * `@estoc/agent-core` ships handlers for trust-ping/2.0,
 * basicmessage/2.0, empty/1.0, report-problem/2.0 and user-profile/1.0;
 * a runtime registers more, and one registered for a type a built-in
 * covers replaces the built-in for that type. An operation's effect
 * type is known to the fold as the runtime scans it: the built-in
 * three always, another only where the scan is told of it, so a
 * handler declares the effect types it produces.
 */

import type { JsonObject } from "@estoc/event-store/v3";
import type { Execution, Source, VaultFold } from "@estoc/vault/v3";

import type { EffectContent } from "../send.js";

/** An established input as a handler is shown it. */
export interface Input {
  readonly execution: Execution;
  /** the complete witness the output's fields are read from: its headers are in the event */
  readonly source: Source;
  /** the stored body of the input; null once the message is erased, and when the body is not here or too large to read */
  readBody(): Promise<JsonObject | null>;
  /** the clock, in milliseconds since the epoch */
  now(): number;
}

/** What an operation gives the input: its content, or nothing and why. */
export type Response = { readonly effectType: string; readonly content: EffectContent } | { readonly effectType: string; readonly content: null; readonly because: string };

export interface Handler {
  /** the message type URIs this handler answers */
  readonly types: readonly string[];
  /** the effect types of the operations it produces, one intent at most each */
  readonly effectTypes: readonly string[];
  /** the outputs the input earns now, each under one of `effectTypes`; none for a type that answers nothing */
  respond(input: Input, fold: VaultFold): Promise<readonly Response[]>;
}

/** The handler for a message type: the first of `handlers` that names it, null when none does. */
export function handlerFor(handlers: readonly Handler[], msgType: string): Handler | null {
  return handlers.find((handler) => handler.types.includes(msgType)) ?? null;
}

/** Every effect type the handlers produce, for the fold to know. */
export function effectTypesOf(handlers: readonly Handler[]): string[] {
  return [...new Set(handlers.flatMap((handler) => handler.effectTypes))];
}
