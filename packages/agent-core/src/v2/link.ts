/**
 * The line to the mediator: what every ritual (coordinate-mediation,
 * messagepickup) and every pickup rides. Sealing to the mediator from
 * the key of ours it knows us by (`me`), opening what it sends back,
 * the HTTP round trip a ritual is, the socket live delivery comes down —
 * and the trace of all of it: the frame on `wire` (and its bytes on
 * `wire.bytes`), the envelope on `envelope`, the ritual's plaintext on
 * `mediation`, each line hung on the one it happened inside. The link
 * decides nothing: what a grant means, what a delivery carries, when to
 * reconnect, is the caller's; the link is the wire and what was seen
 * on it.
 *
 * The wire behaviour itself — the DID shapes, second timestamps, the
 * WebSocket ritual, `return_route` on every request — is what mediator-ts
 * pins in its demo-interop test. Moved from the v1 agent as it was, the
 * trace written through `AgentTrace`.
 */

import type { DIDDoc, Secret } from "@estoc/did-peer";
import type { JsonObject } from "@estoc/event-store";

import type { PeerIdentity } from "../identity/peer.js";
import { ENCRYPTED_MIME, didOf, endpointOf, plainMessage, secretsResolverFor, type DidcommApi, type IMessage, type UnpackMetadata } from "../protocol/didcomm.js";
import { envelopeHeader } from "../protocol/envelope.js";
import { LIVE_DELIVERY_CHANGE } from "../protocol/mediation.js";
import { senderOf } from "./channel.js";
import type { AgentTrace, TraceData, TraceStream } from "./trace.js";

export interface LinkOptions {
  didcomm: DidcommApi;
  resolveDid: (did: string) => Promise<DIDDoc | null>;
  /** transports, injectable for tests; default to the globals */
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  trace: AgentTrace;
  /** every secret this device holds: what an envelope may be opened with, whatever key it was sealed to */
  secrets: () => Secret[];
  /** the key of ours the mediator knows us by — the current mediation's `me`; throws when there is none */
  me: () => PeerIdentity;
  mediatorDid: string;
  /** the mediator's document, resolved by the caller: where `http()` and `ws()` read the endpoints */
  mediatorDoc: DIDDoc;
  /** how long a whole ritual round trip may take — pack, POST and unpack together — before giving up; default 15s (`Outbound.deliver` runs the same budget over a delivery) */
  timeoutMs?: number;
  /** a line for the human log: a trace that could not be written is reported here, not thrown, and a socket frame that failed */
  log?: (line: string) => void;
}

/** An envelope opened: the plaintext and what the envelope itself proves. */
export interface Opened {
  msg: IMessage;
  /** the DID whose key proved the envelope — sealed it, or signed it when no one sealed it (`senderOf`); null when anonymous */
  sender: string | null;
  /** the DID of ours it was opened with: the first key it was sealed to that this device holds, as `inboundPair` names `myKey`; null when it was not sealed */
  recipient: string | null;
  /** a `from_prior` header didcomm-rust verified: signed by `iss`, naming `sub` */
  fromPrior: { iss: string; sub: string; jwt: string } | null;
  /** what didcomm says of the envelope: the channel is read from it (`inboundPair`) */
  metadata: UnpackMetadata;
  /**
   * The documents didcomm resolved to open it — the sender's, a signer's,
   * a `from_prior` issuer's — by DID, each resolved once for the whole
   * open: what the envelope was verified against, so that the channel is
   * read from the same and not from a later resolution that may say
   * otherwise.
   */
  documents: ReadonlyMap<string, DIDDoc>;
  /**
   * The `envelope.open` observation, prepared at unpack and written by
   * `noteOpen` once the message's fate is known — so the line can name
   * the record it ended in.
   */
  open: TraceData;
  /** the eid `noteOpen` gave the observation */
  eid?: string;
}

/** A packed envelope with its `envelope.seal` observation, written once the frame it rides is known (`traceSeal`). */
export interface Sealed {
  packed: string;
  seal: TraceData;
}

/**
 * A mediation ritual message as the `mediation` stream keeps it: the
 * plaintext with attachment bodies replaced by their sizes — the bytes
 * are ciphertext already on `wire.bytes`, or opened envelopes of their own.
 */
export function ritual(msg: IMessage): JsonObject {
  const attachments = msg.attachments;
  if (!Array.isArray(attachments)) {
    return msg as unknown as JsonObject;
  }
  return {
    ...msg,
    attachments: attachments.map((a) => {
      const data = (a as { data?: { base64?: unknown; json?: unknown } }).data;
      const bytes =
        typeof data?.base64 === "string" ? data.base64.length : data?.json !== undefined ? JSON.stringify(data.json).length : 0;
      return { ...(a as object), data: { bytes } };
    }),
  } as unknown as JsonObject;
}

/** The `envelope.seal` line's data: the header read off the bytes, and the plaintext's type. */
export function sealData(packed: string, plain: IMessage): TraceData {
  return { ...envelopeHeader(packed), type: plain.type };
}

const utf8 = new TextEncoder();
function utf8Length(text: string): number {
  return utf8.encode(text).length;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The DID of ours an envelope was opened with: the first of the kids it
 * was sealed to whose secret this device holds — the one didcomm opened
 * it with. didcomm-rust seals to the keys of one DID only, so the first
 * kid is usually ours too; an envelope crafted by hand can name anyone's
 * key first, and the first kid is then no DID of ours.
 */
function openedWith(kids: readonly string[], secrets: readonly Secret[]): string | null {
  const held = new Set(secrets.map((secret) => secret.id));
  return didOf(kids.find((kid) => held.has(kid)));
}

/**
 * `work`, unless `signal` fires first. The deadline is the caller's,
 * one for a whole ritual or delivery: a resolver or a seal that never
 * settles must not hold the queue it runs on. Work that loses the race
 * is abandoned — its late result is dropped, its late failure
 * swallowed; the caller has already thrown, so nothing downstream of
 * the loss (a POST after a pack) runs.
 */
export function bounded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const running = work();
    const onAbort = (): void => {
      running.catch(() => undefined);
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    running.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

export class MediatorLink {
  private readonly didcomm: DidcommApi;
  private readonly resolver: { resolve: (did: string) => Promise<DIDDoc | null> };
  private readonly fetchFn: typeof fetch;
  private readonly WebSocketCtor: typeof WebSocket;
  private readonly trace: AgentTrace;
  private readonly secrets: () => Secret[];
  private readonly me: () => PeerIdentity;
  private readonly mediatorDoc: DIDDoc;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  readonly mediatorDid: string;
  private socket: WebSocket | null = null;

  constructor(options: LinkOptions) {
    this.didcomm = options.didcomm;
    this.resolver = { resolve: (did) => options.resolveDid(did) };
    // wrapped, not assigned: calling a native fetch with `this` bound to
    // anything but the global is an "Illegal invocation" in browsers
    const fetchImpl = options.fetch ?? fetch;
    this.fetchFn = (input, init) => fetchImpl(input, init);
    this.WebSocketCtor = options.WebSocket ?? WebSocket;
    this.trace = options.trace;
    this.secrets = options.secrets;
    this.me = options.me;
    this.mediatorDid = options.mediatorDid;
    this.mediatorDoc = options.mediatorDoc;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.log = options.log ?? (() => undefined);
  }

  /** The mediator's HTTP endpoint; throws when its document lists none. */
  http(): string {
    const endpoint = endpointOf(this.mediatorDoc, "http");
    if (endpoint === null) {
      throw new Error("mediator has no HTTP endpoint");
    }
    return endpoint;
  }

  /** The mediator's WebSocket endpoint; throws when its document lists none. */
  ws(): string {
    const endpoint = endpointOf(this.mediatorDoc, "ws");
    if (endpoint === null) {
      throw new Error("mediator has no WebSocket endpoint");
    }
    return endpoint;
  }

  /** Is a socket open, or opening? False once it closed, whoever closed it. */
  get live(): boolean {
    return this.socket !== null;
  }

  /**
   * Seal a message to `to` from a key of ours (`from`), or anonymously
   * (null): one layer, no forward — every layer an envelope has passes
   * through the caller's hands. What the envelope looks like is in
   * `seal`, for `traceSeal` once the frame it rides is known. A
   * document among `documents` is what didcomm seals to, resolved
   * again for no one: the caller read the address off it, and the key
   * is read off the same.
   */
  async seal(message: IMessage, to: string, from: string | null, documents?: ReadonlyMap<string, DIDDoc>): Promise<Sealed> {
    const resolver = documents === undefined ? this.resolver : { resolve: async (did: string): Promise<DIDDoc | null> => documents.get(did) ?? this.resolver.resolve(did) };
    const [packed] = await new this.didcomm.Message(message).pack_encrypted(to, from, null, resolver, secretsResolverFor(this.secrets()), { forward: false });
    return { packed, seal: sealData(packed, message) };
  }

  /**
   * Seal a message from the mediator-facing DID to the mediator itself.
   * Every such request declares the connection it arrives on as its return
   * route — messagepickup 3.0 requires clients to say so explicitly, once
   * per WebSocket and on every HTTP POST.
   */
  pack(message: IMessage): Promise<Sealed> {
    return this.seal({ ...message, return_route: "all" } as IMessage, this.mediatorDid, this.me().did);
  }

  /**
   * Open an envelope; `parent` is the observation it arrived inside (the
   * frame, or the delivery it was attached to). One that will not open
   * leaves an `envelope.error` line and throws; one that does is
   * described in the returned `open`, written by `noteOpen`.
   */
  async unpack(packed: string, parent?: string): Promise<Opened> {
    const open: TraceData = { ...envelopeHeader(packed), parent };
    const secrets = this.secrets();
    const documents = new Map<string, DIDDoc>();
    const pending = new Map<string, Promise<DIDDoc | null>>();
    const resolver = {
      // one resolution per DID for the whole open, however many times didcomm asks (a signature to verify, a
      // key to decrypt with, a from_prior to check): what it verified against is one document, and the one kept
      resolve: (did: string): Promise<DIDDoc | null> => {
        let resolving = pending.get(did);
        if (resolving === undefined) {
          resolving = this.resolver.resolve(did).then((doc) => {
            if (doc !== null) {
              documents.set(did, doc);
            }
            return doc;
          });
          pending.set(did, resolving);
        }
        return resolving;
      },
    };
    let unpacked: Awaited<ReturnType<DidcommApi["Message"]["unpack"]>>;
    try {
      unpacked = await this.didcomm.Message.unpack(packed, resolver, secretsResolverFor(secrets), {});
    } catch (err) {
      void this.note("envelope", "envelope.error", { ...open, error: messageOf(err) });
      throw err;
    }
    const [msg, metadata] = unpacked;
    const value = msg.as_value();
    // the binding hands back null, not undefined, for a header that is not there
    const rotation = metadata.from_prior ?? null;
    open.type = value.type;
    if (metadata.encrypted_from_kid !== undefined) open.from_kid = metadata.encrypted_from_kid;
    if (metadata.encrypted_to_kids !== undefined) open.to_kids = metadata.encrypted_to_kids;
    if (metadata.non_repudiation && metadata.sign_from !== undefined) open.sign_from = metadata.sign_from;
    if (metadata.re_wrapped_in_forward) open.re_wrapped_in_forward = true;
    if (rotation !== null) open.from_prior = { iss: rotation.iss, sub: rotation.sub };
    return {
      msg: value,
      sender: senderOf(metadata),
      recipient: openedWith(metadata.encrypted_to_kids ?? [], secrets),
      fromPrior: rotation === null ? null : { iss: rotation.iss, sub: rotation.sub, jwt: value.from_prior as string },
      metadata,
      documents,
      open,
    };
  }

  /** POST to the mediator and unpack the reply riding the HTTP response. */
  async roundTrip(type: string, body: Record<string, unknown>): Promise<IMessage> {
    return (await this.exchange(type, body)).msg;
  }

  /**
   * `roundTrip` with the opened reply whole, for what needs its
   * observation as a parent. Throws when the line is cut, before or
   * during the answer (`wire.error` written), when the mediator
   * answers anything but 2xx (the answer on `wire`, unopened), or at
   * the deadline — `timeoutMs` runs from entry and covers the whole
   * ritual, pack and unpack with their resolutions included, not just
   * the POST: the queue a ritual rides must not hang on a wire or a
   * resolver that never answers, and no ritual needs an answer to stay
   * safe (`leave` drops every DID that might have been told, answered
   * or not). The cut is at the wire: before the POST every wait — the
   * notes included — fails the ritual at the deadline, nothing having
   * been sent; once the answer is in hand, only the noting of it can
   * still lose the race, and it loses alone (`noted`) — the answer
   * stands.
   */
  async exchange(type: string, body: Record<string, unknown>): Promise<Opened> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const message = plainMessage(type, this.me().did, this.mediatorDid, body);
    const { packed, seal } = await bounded(signal, () => this.pack(message));
    const endpoint = this.http();
    const out = await bounded(signal, () => this.traceOut("http", endpoint, packed, { type }));
    await bounded(signal, () => this.traceSeal(seal, out, message));
    const { ok, status, text, ms } = await bounded(signal, () => this.post(endpoint, packed, out, signal));
    // the note of the reply runs beside the unpack, not before it: a note
    // that jams must not spend the budget the unpack still needs — and an
    // answer is noted whatever its status, before a bad one throws
    const noting = this.noted(signal, () => this.traceIn("http", text, { parent: out, status, ms }));
    if (!ok) {
      await noting;
      throw new Error(`mediator answered ${status} to ${type}`);
    }
    const opened = await bounded(signal, () => this.unpack(text));
    opened.open.parent = await noting;
    await this.noted(signal, () => this.noteOpen(opened));
    this.noteRitual(opened);
    return opened;
  }

  /**
   * POST a frame already traced as `out` (`traceOut`) — to the mediator,
   * or to wherever a contact's document says — and read what came back:
   * the status, the text, and how long the wire took. Throws when the
   * line is cut, before or during the answer, with `wire.error`
   * written; a status that is no 2xx is the caller's to judge. `signal`
   * bounds the wait: an answer not in hand by the deadline is a
   * failure — and the caller races the whole call too (`bounded`),
   * since an injected fetch may ignore the signal. The reply's `wire.in` note is the caller's (`traceIn`),
   * under its own semantics — once the answer is in hand, a note that
   * hangs must lose alone, never retell a 2xx the far side applied as
   * a failure, nor starve what the caller still does with the text.
   */
  async post(endpoint: string, packed: string, out: string | undefined, signal?: AbortSignal): Promise<{ ok: boolean; status: number; text: string; ms: number }> {
    const started = Date.now();
    let response: Response;
    let text: string;
    try {
      response = await this.fetchFn(endpoint, {
        method: "POST",
        headers: { "Content-Type": ENCRYPTED_MIME },
        body: packed,
        ...(signal === undefined ? {} : { signal }),
      });
      text = await response.text();
    } catch (err) {
      void this.note("wire", "wire.error", { via: "http", parent: out, ms: Date.now() - started, error: messageOf(err) });
      throw err;
    }
    return { ok: response.ok, status: response.status, text, ms: Date.now() - started };
  }

  /**
   * Open the socket and switch live delivery on: live-delivery-change is
   * the first frame it ever carries. Every frame that comes down is
   * opened, noted, and handed to `onFrame` — a status, a delivery; what
   * they mean is the caller's — one that will not open, or that `onFrame`
   * threw on, is logged and dropped. `onClose` is told when the socket
   * closed on its own: dropped by the mediator, or closed here because
   * live delivery could not be switched on. Not when `closeSocket`
   * closed it — so reconnecting, and when, is the caller's. Throws when
   * the mediator lists no WebSocket endpoint.
   */
  openSocket(onFrame: (opened: Opened) => Promise<void> | void, onClose?: () => void): void {
    const uri = this.ws();
    this.closeSocket();
    const socket = new this.WebSocketCtor(uri);
    this.socket = socket;

    socket.onopen = async () => {
      try {
        const plain = plainMessage(LIVE_DELIVERY_CHANGE, this.me().did, this.mediatorDid, { live_delivery: true });
        const { packed, seal } = await this.pack(plain);
        socket.send(packed);
        await this.traceSeal(seal, await this.traceOut("ws", uri, packed, { type: plain.type }), plain);
      } catch (err) {
        // an unhandled rejection here would leave the socket open and
        // live delivery never switched on; closing it hands the caller
        // its onClose, and the reconnect that goes with it
        this.log(`could not open live delivery: ${messageOf(err)}`);
        socket.close();
      }
    };

    socket.onmessage = async (event: MessageEvent) => {
      const text = typeof event.data === "string" ? event.data : await (event.data as Blob).text();
      let opened: Opened;
      try {
        opened = await this.unpack(text, await this.traceIn("ws", text, { endpoint: uri }));
      } catch (err) {
        this.log(`could not open a socket frame: ${messageOf(err)}`);
        return;
      }
      await this.noteOpen(opened);
      this.noteRitual(opened);
      try {
        await onFrame(opened);
      } catch (err) {
        this.log(`a socket frame was not handled: ${messageOf(err)}`);
      }
    };

    socket.onclose = () => {
      // closed by us (`closeSocket`): not ours to report
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      onClose?.();
    };
  }

  /** Close the socket on purpose: its close handler sees it is no longer ours and tells no one. */
  closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /** A frame going out: its header on `wire`, its bytes on `wire.bytes`; returns the frame's eid. */
  async traceOut(via: "http" | "ws", endpoint: string, body: string, extra: TraceData = {}): Promise<string | undefined> {
    const eid = await this.note("wire", "wire.out", { via, endpoint, bytes: utf8Length(body), ...extra });
    if (this.trace.enabled("wire.bytes")) {
      void this.note("wire.bytes", "wire.out", { parent: eid, body });
    }
    return eid;
  }

  /** A frame that came in, the same way; `parent` is the request it answers, when it answers one. */
  async traceIn(via: "http" | "ws", body: string, extra: TraceData = {}): Promise<string | undefined> {
    const eid = await this.note("wire", "wire.in", { via, bytes: utf8Length(body), ...extra });
    if (this.trace.enabled("wire.bytes")) {
      void this.note("wire.bytes", "wire.in", { parent: eid, body });
    }
    return eid;
  }

  /** The `envelope.seal` line inside `parent`, and the plaintext on `mediation` when it was a ritual with a mediator. */
  async traceSeal(seal: TraceData, parent: string | undefined, plain?: IMessage): Promise<string | undefined> {
    const eid = await this.note("envelope", "envelope.seal", { ...seal, parent });
    if (plain !== undefined) {
      void this.note("mediation", "mediation.out", { parent: eid, msg: ritual(plain) });
    }
    return eid;
  }

  /** The `envelope.open` line of an opened envelope, naming the record it ended in when it did. */
  async noteOpen(opened: Opened, mid?: string): Promise<string | undefined> {
    const eid = await this.note("envelope", "envelope.open", mid === undefined ? opened.open : { ...opened.open, mid });
    opened.eid = eid;
    return eid;
  }

  /** An opened ritual message from a mediator, in the clear on `mediation`. */
  noteRitual(opened: Opened): void {
    void this.note("mediation", "mediation.in", { parent: opened.eid, msg: ritual(opened.msg) });
  }

  /**
   * One line of the trace. A trace that cannot be written is not a
   * reason to stop sending: the failure is logged and the line's eid is
   * nothing — what would have hung on it hangs on nothing, as when the
   * stream was off.
   */
  private async note(stream: TraceStream, type: string, data: TraceData): Promise<string | undefined> {
    try {
      return await this.trace.append(stream, type, data);
    } catch (err) {
      this.log(`trace not written: ${messageOf(err)}`);
      return undefined;
    }
  }

  /**
   * A trace wait that is observability only: what it would note is
   * already in hand, so losing the race loses the line alone — the
   * waiting stops at the deadline, the loss is logged, and what was
   * won stands. The notes before a POST ride `bounded` directly
   * instead: no side effect has happened yet, and the deadline fails
   * the whole exchange.
   */
  private async noted(signal: AbortSignal | undefined, work: () => Promise<string | undefined>): Promise<string | undefined> {
    if (signal === undefined) {
      return work();
    }
    try {
      return await bounded(signal, work);
    } catch {
      this.log("trace not written: the deadline passed while noting");
      return undefined;
    }
  }
}
