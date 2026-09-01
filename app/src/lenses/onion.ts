import { tracePolicy, type TraceEvent, type TraceLevel } from "@estoc/agent-core";

/**
 * A message's trace, folded into the layers it crossed: the frame on the
 * wire outermost, then each envelope inside it, then the plaintext. The
 * agent only ever recorded raw observations — `wire.in`, `envelope.open`,
 * `envelope.seal`, … each hung on the one it happened inside by
 * `data.parent` — so the onion is nothing but that parent chain read
 * outermost-first, from the envelope that ended in (or began as) the
 * record. What a layer means to a person — who can see into it, what it
 * is for — is this fold's reading, not the trace's.
 */
export type LayerKind = "wire" | "forward" | "anoncrypt" | "authcrypt" | "signed" | "plain" | "unknown" | "plaintext";

export interface OnionLayer {
  kind: LayerKind;
  title: string;
  /** who can see into this layer */
  visibleTo: string;
  note: string;
  /** what the trace (or the record) holds for this layer, for the raw view */
  raw: unknown;
  /** the observation this layer is, when it is one */
  event?: TraceEvent;
}

export interface Onion {
  layers: OnionLayer[];
  /** `sent` when the chain is one of seals, `received` when of opens */
  direction: "sent" | "received";
  /** how many chains ended in this record: every delivery attempt seals afresh */
  attempts: number;
  /** what was said to the mediator on the same frame: the pickup ritual, when it was one */
  mediation: TraceEvent[];
}

const FORWARD = "https://didcomm.org/routing/2.0/forward";

/** did:peer:4 long forms run ~800 characters; show head and tail. */
function short(id: string): string {
  return id.length <= 36 ? id : `${id.slice(0, 22)}…${id.slice(-8)}`;
}

/** The DID part of a key id (`did#key` → `did`). */
function didOf(kid: string): string {
  return kid.split("#")[0] ?? kid;
}

function names(ids: unknown): string {
  return Array.isArray(ids) ? [...new Set(ids.map((k) => short(didOf(String(k)))))].join(", ") : "?";
}

/** The observation for the raw view: when and what, and everything it recorded — the chain pointer aside. */
function rawOf(event: TraceEvent): unknown {
  const { parent: _parent, ...data } = event.data;
  return { type: event.type, at: event.at, ...data };
}

function kindOf(event: TraceEvent): LayerKind {
  if (event.data["type"] === FORWARD) {
    return "forward";
  }
  const kind = event.data["kind"];
  return kind === "authcrypt" || kind === "anoncrypt" || kind === "signed" || kind === "plain" ? kind : "unknown";
}

function envelopeLayer(event: TraceEvent, direction: "sent" | "received", innermost: boolean): OnionLayer {
  const kind = kindOf(event);
  const raw = rawOf(event);
  const opened = direction === "received";
  const tos = names(event.data["to_kids"] ?? event.data["kids"]);
  switch (kind) {
    case "forward":
      return {
        kind,
        title: "a forward request",
        visibleTo: `${tos} (the mediator)`,
        note: opened
          ? "The mediator opened this and queued what was inside for you; it sees the next key it is for and nothing else."
          : "Sealed to the mediator alone — anonymously. It learns the next key to hand the inside to, and nothing else.",
        raw,
        event,
      };
    case "anoncrypt":
      return {
        kind,
        title: opened ? "an anonymous envelope" : "sealed anonymously",
        visibleTo: tos,
        note: "Encrypted to the recipient's key with no proof of who sealed it.",
        raw,
        event,
      };
    case "authcrypt": {
      const from = event.data["from_kid"] ?? event.data["skid"];
      const who = typeof from === "string" ? short(didOf(from)) : "?";
      return {
        kind,
        title: innermost ? (opened ? "the message, sealed to you" : "the message, sealed to them") : opened ? "the mediator's delivery, sealed to you" : "sealed to the mediator",
        visibleTo: `${who} and ${tos}`,
        note: innermost
          ? `Encrypted to ${tos} and authenticated as ${who}: only the two ends can read it, and the reader knows who sealed it.${event.data["re_wrapped_in_forward"] ? " It reached you inside a forward the mediator opened." : ""}`
          : "The mediator's own message to you (its pickup protocol), sealed and authenticated as the mediator.",
        raw,
        event,
      };
    }
    case "signed":
      return { kind, title: "a signed envelope", visibleTo: "anyone who holds it", note: "Signed, not encrypted: readable by all, vouched for by its signer.", raw, event };
    case "plain":
      return { kind, title: "a plaintext envelope", visibleTo: "anyone who holds it", note: "Neither sealed nor signed.", raw, event };
    default:
      return { kind, title: "an envelope", visibleTo: "?", note: `Not read: ${String(event.data["error"] ?? "an envelope of a kind this build does not know")}`, raw, event };
  }
}

function wireLayer(event: TraceEvent, children: TraceEvent[]): OnionLayer {
  const via = event.data["via"] === "ws" ? "the WebSocket" : "HTTP";
  const bytes = typeof event.data["bytes"] === "number" ? `${event.data["bytes"]} bytes` : "";
  const body = children.find((c) => c.stream === "wire.bytes")?.data["body"];
  const reply = children.find((c) => c.stream === "wire" && c.type === "wire.in");
  const failed = children.find((c) => c.stream === "wire" && c.type === "wire.error");
  const out = event.type === "wire.out";
  const endpoint = event.data["endpoint"];
  const where = typeof endpoint === "string" ? ` to ${endpoint}` : "";
  const answered =
    reply !== undefined
      ? ` The endpoint answered ${String(reply.data["status"])} in ${String(reply.data["ms"])} ms.`
      : failed !== undefined
        ? ` The request failed: ${String(failed.data["error"])}.`
        : "";
  return {
    kind: "wire",
    title: out ? `sent over ${via}${where}` : `arrived over ${via}`,
    visibleTo: "the network between here and the endpoint (TLS aside)",
    note: `${bytes ? `${bytes} on the wire. ` : ""}${out ? "The outermost envelope is what left this device." : "The outermost envelope is what reached this device."}${answered}`.trim(),
    raw: body ?? rawOf(event),
    event,
  };
}

/**
 * Fold the trace of one record. `plaintext` is the record's message (the
 * log's fact, not the trace's), shown innermost when the chain is found.
 * Empty layers: nothing observed for this record — the trace was off, or
 * its part is pruned.
 */
export function foldOnion(events: TraceEvent[], mid: string, plaintext?: unknown): Onion {
  const byEid = new Map(events.map((e) => [e.eid, e]));
  const children = new Map<string, TraceEvent[]>();
  for (const e of events) {
    const parent = e.data["parent"];
    if (typeof parent === "string") {
      children.set(parent, [...(children.get(parent) ?? []), e]);
    }
  }
  // the innermost envelopes that ended in this record — one per delivery attempt; the latest is shown
  const ends = events.filter((e) => e.stream === "envelope" && e.data["mid"] === mid).sort((a, b) => a.at.localeCompare(b.at));
  const end = ends[ends.length - 1];
  if (end === undefined) {
    return { layers: [], direction: "received", attempts: 0, mediation: [] };
  }
  const direction = end.type === "envelope.seal" ? "sent" : "received";
  // walk out along parent
  const chain: TraceEvent[] = [];
  for (let e: TraceEvent | undefined = end; e !== undefined; ) {
    chain.unshift(e);
    const parent: unknown = e.data["parent"];
    e = typeof parent === "string" ? byEid.get(parent) : undefined;
  }
  const layers: OnionLayer[] = [];
  const mediation: TraceEvent[] = [];
  for (const [i, e] of chain.entries()) {
    const inside = children.get(e.eid) ?? [];
    if (e.stream === "wire") {
      layers.push(wireLayer(e, inside));
    } else if (e.stream === "envelope") {
      layers.push(envelopeLayer(e, direction, i === chain.length - 1));
    }
    mediation.push(...inside.filter((c) => c.stream === "mediation"));
  }
  if (plaintext !== undefined) {
    layers.push({
      kind: "plaintext",
      title: "the message itself",
      visibleTo: direction === "sent" ? "you and the one it is sealed to" : "you and the one who sealed it",
      note: "What the log keeps: the record, as it was written or as it was opened.",
      raw: plaintext,
    });
  }
  return { layers, direction, attempts: ends.length, mediation };
}

const DAY = 24 * 60 * 60 * 1000;

function days(ms: number): string {
  const d = Math.round(ms / DAY);
  return d === 1 ? "a day" : `${d} days`;
}

/** What a trace level keeps, in words, read off the policy itself so the words cannot drift from it. */
export function traceNote(level: TraceLevel): string {
  if (level === "off") {
    return "nothing observed is kept; no lens has anything to show";
  }
  const { streams } = tracePolicy(level);
  return `envelopes for ${days(streams.envelope.keepMs)}, frames for ${days(streams.wire.keepMs)}, the bytes on the wire for ${days(streams["wire.bytes"].keepMs)}, the mediator's rituals for ${days(streams.mediation.keepMs)}`;
}
