import type { VaultBackend } from "../backend/types.js";
import { DELIVERIES_DIR } from "./layout.js";
import { SegmentedLog } from "./log.js";
import type { MessageRecord } from "./messages.js";

/**
 * The delivery log: what became of each outbound message, as append-only
 * events beside the message log. A message record says *we said this*;
 * a delivery event says *it went* (or did not). Keeping the two apart is
 * what lets a message be written offline and stay a fact — the line in
 * the message log never changes — while its delivery is tried, fails, and
 * is tried again, each attempt a line here.
 *
 * The state of one message is the fold of its events, newest last:
 *
 *   - no event at all: **pending** — written, never yet tried (or the
 *     agent crashed between the append and the attempt: the same thing).
 *   - last event `failed`: tried and not delivered; `error` says why. The
 *     agent tries again at start, when the socket comes back, and before
 *     the next message to the same contact; the user may retry by hand.
 *   - last event `held`: not to be tried unasked. Written by import for
 *     an outbound message another copy of this vault wrote and never
 *     delivered — a backup is a move, not a sync, and this device may not
 *     even hold the DID it was to go from. Only a retry by hand moves it.
 *   - last event `sent`: delivered to the endpoint. Nothing about it is
 *     rewritten later; a message that reached its mediator is sent for
 *     good, and no later state (a receipt, one day) undoes that.
 *
 * Every event repeats `mid`; the log merges by `(mid, attempt, status)`,
 * `attempt` counting the tries of that message from 1 — a `held` carries
 * the count as it stood, since it is not a try. Inbound mail has no
 * delivery: that it arrived is the message record itself.
 */
export interface DeliveryEvent {
  /** the outbound message record this is about */
  mid: string;
  /** ISO time of the event */
  at: string;
  status: "sent" | "failed" | "held";
  /** how many tries this message has had, this one included; 0 for a `held` before any */
  attempt: number;
  /** the DID the envelope was sealed to on this try — the contact's current DID at the time */
  to?: string;
  /** for `failed` and `held`: what went wrong, or why it waits */
  error?: string;
}

/** What the fold of a message's delivery events says about it — see `foldDeliveries`. */
export interface DeliveryState {
  status: DeliveryEvent["status"];
  /** tries so far */
  attempts: number;
  /** ISO time of the last event */
  at: string;
  to?: string;
  error?: string;
}

/**
 * The delivery status of a message as a UI would show it: `pending` for an
 * outbound record with no event yet, the folded status otherwise.
 */
export type DeliveryStatus = DeliveryEvent["status"] | "pending";

function parseLine(line: string, where: string): DeliveryEvent {
  const event = JSON.parse(line) as Partial<DeliveryEvent>;
  if (
    typeof event !== "object" ||
    event === null ||
    typeof event.mid !== "string" ||
    typeof event.at !== "string" ||
    (event.status !== "sent" && event.status !== "failed" && event.status !== "held") ||
    typeof event.attempt !== "number"
  ) {
    throw new Error(`${where} is not a delivery event`);
  }
  return event as DeliveryEvent;
}

export class DeliveryLog extends SegmentedLog<DeliveryEvent> {
  constructor(backend: VaultBackend, segment?: string) {
    super(backend, DELIVERIES_DIR, parseLine, segment);
  }
}

/** The merge identity of an event: one outcome of one try of one message. */
export function deliveryKey(event: DeliveryEvent): string {
  return `${event.mid} ${event.attempt} ${event.status}`;
}

/**
 * Fold events into the current state of every message that has any —
 * newest event wins, tries counted along the way. Events arrive in log
 * order, which is time order within one device and segment order across
 * a merge; `at` breaks the tie so an older device's `failed` does not
 * shadow a newer `sent`, and `sent` is final whatever comes after.
 */
export function foldDeliveries(events: Iterable<DeliveryEvent>): Map<string, DeliveryState> {
  const states = new Map<string, DeliveryState>();
  for (const event of events) {
    const prior = states.get(event.mid);
    const attempts = Math.max(prior?.attempts ?? 0, event.attempt);
    if (prior !== undefined && (prior.status === "sent" || prior.at > event.at)) {
      prior.attempts = attempts;
      continue;
    }
    const state: DeliveryState = { status: event.status, attempts, at: event.at };
    if (event.to !== undefined) {
      state.to = event.to;
    }
    if (event.error !== undefined) {
      state.error = event.error;
    }
    states.set(event.mid, state);
  }
  return states;
}

/** A record's delivery status under `states`; null for inbound mail, which has none. */
export function deliveryStatusOf(
  record: Pick<MessageRecord, "mid" | "direction">,
  states: Map<string, DeliveryState>
): DeliveryStatus | null {
  if (record.direction !== "out") {
    return null;
  }
  return states.get(record.mid)?.status ?? "pending";
}
