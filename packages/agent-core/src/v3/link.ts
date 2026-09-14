/**
 * The line to the mediator: what every ritual (coordinate-mediation,
 * messagepickup) and every pickup rides. Sealing to the mediator from
 * the identity it knows this vault by — the mediation arrangement's
 * own DID — opening what it sends back, the HTTP round trip a ritual
 * is, the socket live delivery comes down, and the trace of all of it:
 * the frame on `wire` (and its bytes on `bytes`), the envelope on
 * `envelope`, the ritual's plaintext on `mediation`, each entry hung
 * on the one it happened inside. The link decides nothing: what a
 * grant means, what a delivery carries, when to reconnect, is the
 * caller's; the link is the wire and what was seen on it.
 *
 * The wire behaviour itself — the DID shapes, second timestamps, the
 * WebSocket ritual, `return_route` on every request — is what
 * mediator-ts pins in its demo-interop test.
 */

import type { DIDDoc, Secret } from "@estoc/did-peer";
import type { JsonObject } from "@estoc/event-store/v3";

import { ENCRYPTED_MIME, didOf, endpointOf, plainMessage, secretsResolverFor, type DidcommApi, type IMessage, type UnpackMetadata } from "../protocol/didcomm.js";
import { envelopeHeader } from "../protocol/envelope.js";
import { LIVE_DELIVERY_CHANGE } from "../protocol/mediation.js";
import { UnverifiedReply } from "./errors.js";
import { sameDid } from "./same-did.js";
import type { AgentTrace, TraceData, TraceStream } from "./trace.js";

export interface LinkOptions {
  didcomm: DidcommApi;
  resolveDid: (did: string) => Promise<DIDDoc | null>;
  /** transports, injectable for tests; default to the globals */
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  trace: AgentTrace;
  /** every secret this runtime holds: what an envelope may be opened with, whatever key it was sealed to */
  secrets: () => Secret[];
  /** the DID the mediator knows this vault by: the arrangement's own, its long form. A link is one arrangement's for its whole life. */
  me: string;
  mediatorDid: string;
  /** the mediator's document, resolved by the caller: where `http()` and `ws()` read the endpoints */
  mediatorDoc: DIDDoc;
  /** how long a whole ritual round trip may take — pack, POST and unpack together — before giving up; default 15s */
  timeoutMs?: number;
  /** a line for the human log: a trace that could not be written is reported here, not thrown, and a socket frame that failed */
  log?: (line: string) => void;
}

/** An envelope opened: the plaintext and what the envelope itself proves. */
export interface Opened {
  msg: IMessage;
  /** the DID whose key proved the envelope — sealed it, or signed it when no one sealed it; null when anonymous */
  sender: string | null;
  /** the DID of ours it was opened with: the first key it was sealed to that this runtime holds; null when it was not sealed */
  recipient: string | null;
  /** a `from_prior` header didcomm-rust verified: signed by `iss`, naming `sub` */
  fromPrior: { iss: string; sub: string; jwt: string } | null;
  /** what didcomm says of the envelope */
  metadata: UnpackMetadata;
  /**
   * The documents didcomm resolved to open it — the sender's, a signer's,
   * a `from_prior` issuer's — by DID, each resolved once for the whole
   * open: what the envelope was verified against, so that what is read
   * of the sender is read from the same and not from a later resolution.
   */
  documents: ReadonlyMap<string, DIDDoc>;
  /** The `envelope.open` observation, prepared at unpack and written by `noteOpen` once the message's fate is known. */
  open: TraceData;
  /** the sequence number `noteOpen` gave the observation */
  seq?: number;
}

/** A packed envelope with its `envelope.seal` observation, written once the frame it rides is known (`traceSeal`). */
export interface Sealed {
  packed: string;
  seal: TraceData;
}

/**
 * The DID of the key that sealed the envelope as authcrypt; null when
 * none did. The binding reports a header that is not there as null,
 * whatever its typing says, so only a string names a sealer.
 */
export function sealerOf(metadata: UnpackMetadata): string | null {
  return typeof metadata.encrypted_from_kid === "string" ? didOf(metadata.encrypted_from_kid) : null;
}

/** The DID whose key proved the envelope: the sealer of an authcrypt, the signer of a signed one, no one otherwise. */
export function senderOf(metadata: UnpackMetadata): string | null {
  return sealerOf(metadata) ?? (metadata.non_repudiation && typeof metadata.sign_from === "string" ? didOf(metadata.sign_from) : null);
}

/** A mediation ritual message as the `mediation` stream keeps it: the plaintext with attachment bodies replaced by their sizes. */
export function ritual(msg: IMessage): JsonObject {
  const attachments = msg.attachments;
  if (!Array.isArray(attachments)) return msg as unknown as JsonObject;
  return {
    ...msg,
    attachments: attachments.map((a) => {
      const data = (a as { data?: { base64?: unknown; json?: unknown } }).data;
      const bytes = typeof data?.base64 === "string" ? data.base64.length : data?.json !== undefined ? JSON.stringify(data.json).length : 0;
      return { ...(a as object), data: { bytes } };
    }),
  } as unknown as JsonObject;
}

/** The `envelope.seal` entry's data: the header read off the bytes, and the plaintext's type. */
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

/** The DID of ours an envelope was opened with: the first of the kids it was sealed to whose secret this runtime holds. */
function openedWith(kids: readonly string[], secrets: readonly Secret[]): string | null {
  const held = new Set(secrets.map((secret) => secret.id));
  return didOf(kids.find((kid) => held.has(kid)));
}

/**
 * `work`, unless `signal` fires first. The deadline is the caller's,
 * one for a whole ritual or delivery: a resolver or a seal that never
 * settles must not hold the queue it runs on. Work that loses the race
 * is abandoned — its late result dropped, its late failure swallowed.
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
  readonly trace: AgentTrace;
  private readonly secrets: () => Secret[];
  readonly me: string;
  private readonly mediatorDoc: DIDDoc;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  readonly mediatorDid: string;
  private socket: WebSocket | null = null;

  constructor(options: LinkOptions) {
    this.didcomm = options.didcomm;
    this.resolver = { resolve: (did) => options.resolveDid(did) };
    // wrapped, not assigned: a native fetch called with `this` bound to anything but the global is an "Illegal invocation" in browsers
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
    if (endpoint === null) throw new Error("mediator has no HTTP endpoint");
    return endpoint;
  }

  /** The mediator's WebSocket endpoint; throws when its document lists none. */
  ws(): string {
    const endpoint = endpointOf(this.mediatorDoc, "ws");
    if (endpoint === null) throw new Error("mediator has no WebSocket endpoint");
    return endpoint;
  }

  /** Is a socket open, or opening? False once it closed, whoever closed it. */
  get live(): boolean {
    return this.socket !== null;
  }

  /**
   * Seal a message to `to` from a key of ours (`from`), or anonymously
   * (null): one layer, no forward — every layer an envelope has passes
   * through the caller's hands. A document among `documents` is what
   * didcomm seals to, resolved again for no one.
   */
  async seal(message: IMessage, to: string, from: string | null, documents?: ReadonlyMap<string, DIDDoc>): Promise<Sealed> {
    const resolver = documents === undefined ? this.resolver : { resolve: async (did: string): Promise<DIDDoc | null> => documents.get(did) ?? this.resolver.resolve(did) };
    const [packed] = await new this.didcomm.Message(message).pack_encrypted(to, from, null, resolver, secretsResolverFor(this.secrets()), { forward: false });
    return { packed, seal: sealData(packed, message) };
  }

  /** Seal a message from the arrangement's own DID to the mediator, declaring the connection it arrives on as its return route, as messagepickup 3.0 requires of every request. */
  pack(message: IMessage): Promise<Sealed> {
    return this.seal({ ...message, return_route: "all" } as IMessage, this.mediatorDid, this.me);
  }

  /**
   * Open an envelope; `parent` is the observation it arrived inside (the
   * frame, or the delivery it was attached to). One that will not open
   * leaves an `envelope.error` entry and throws; one that does is
   * described in the returned `open`, written by `noteOpen`.
   */
  async unpack(packed: string, parent?: number): Promise<Opened> {
    const open: TraceData = { ...envelopeHeader(packed), parent };
    const secrets = this.secrets();
    const documents = new Map<string, DIDDoc>();
    const pending = new Map<string, Promise<DIDDoc | null>>();
    const resolver = {
      // one resolution per DID for the whole open, however many times didcomm asks: what it verified against is one document, and the one kept
      resolve: (did: string): Promise<DIDDoc | null> => {
        let resolving = pending.get(did);
        if (resolving === undefined) {
          resolving = this.resolver.resolve(did).then((doc) => {
            if (doc !== null) documents.set(did, doc);
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
      void this.note("envelope", "error", { ...open, error: messageOf(err) });
      throw err;
    }
    const [msg, metadata] = unpacked;
    const value = msg.as_value();
    // the binding hands back null, not undefined, for a header that is not there
    const rotation = metadata.from_prior ?? null;
    open.type = value.type;
    if (typeof metadata.encrypted_from_kid === "string") open.from_kid = metadata.encrypted_from_kid;
    if (Array.isArray(metadata.encrypted_to_kids)) open.to_kids = metadata.encrypted_to_kids;
    if (metadata.non_repudiation && typeof metadata.sign_from === "string") open.sign_from = metadata.sign_from;
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
   * the deadline: `timeoutMs` runs from entry and covers the whole
   * ritual, pack and unpack with their resolutions included. Before
   * the POST every wait fails the ritual at the deadline, nothing
   * having been sent; once the answer is in hand, only the noting of
   * it can still lose the race, and it loses alone.
   */
  async exchange(type: string, body: Record<string, unknown>): Promise<Opened> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const message = plainMessage(type, this.me, this.mediatorDid, body);
    const { packed, seal } = await bounded(signal, () => this.pack(message));
    const endpoint = this.http();
    const out = await bounded(signal, () => this.traceOut("http", endpoint, packed, { type }));
    await bounded(signal, () => this.traceSeal(seal, out, message));
    const { ok, status, text, ms } = await bounded(signal, () => this.post(endpoint, packed, out, signal));
    // the note of the reply runs beside the unpack, not before it: a note that jams must not spend the budget the unpack still needs
    const noting = this.noted(signal, () => this.traceIn("http", text, { parent: out, status, ms }));
    if (!ok) {
      await noting;
      throw new Error(`mediator answered ${status} to ${type}`);
    }
    const opened = await bounded(signal, () => this.unpack(text));
    opened.open.parent = await noting;
    await this.noted(signal, () => this.noteOpen(opened));
    await this.fromMediator(opened, signal);
    this.noteRitual(opened);
    return opened;
  }

  /**
   * What the mediator sends down the line counts only when the envelope
   * is authcrypt from the mediator's key to the arrangement's own DID.
   * Sender protection, an anonymous layer over that authcrypt, still
   * carries it. A signature under an anonymous seal does not, whoever
   * signed: a signed plaintext proves who wrote it once, not who sends
   * it now, since anyone holding it can seal it to us again. The note
   * of a refusal is observability only: it waits at most for `signal`,
   * and not at all without one.
   */
  private async fromMediator(opened: Opened, signal?: AbortSignal): Promise<void> {
    const { metadata, recipient } = opened;
    const sealer = sealerOf(metadata);
    const reason = sealer === null
      ? "not authenticated encryption"
      : !sameDid(sealer, this.mediatorDid)
        ? `sealed by ${sealer}`
        : recipient === null || !sameDid(recipient, this.me)
          ? `sealed to ${recipient ?? "no key of ours"}`
          : null;
    if (reason === null) return;
    const noting = (): Promise<number | undefined> => this.note("envelope", "rejected", { parent: opened.seq, reason });
    if (signal === undefined) void noting();
    else await this.noted(signal, noting);
    throw new UnverifiedReply(reason);
  }

  /**
   * POST a frame already traced as `out` (`traceOut`) and read what
   * came back: the status, the text, and how long the wire took.
   * Throws when the line is cut, with `wire.error` written; a status
   * that is no 2xx is the caller's to judge. `signal` bounds the wait,
   * and the caller races the whole call too, since an injected fetch
   * may ignore the signal.
   */
  async post(endpoint: string, packed: string, out: number | undefined, signal?: AbortSignal): Promise<{ ok: boolean; status: number; text: string; ms: number }> {
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
      void this.note("wire", "error", { via: "http", parent: out, ms: Date.now() - started, error: messageOf(err) });
      throw err;
    }
    return { ok: response.ok, status: response.status, text, ms: Date.now() - started };
  }

  /**
   * Open the socket and switch live delivery on: live-delivery-change is
   * the first frame it ever carries. Every frame that comes down is
   * opened, noted, and handed to `onFrame`; one that will not open, or
   * that `onFrame` threw on, is logged and dropped. `onClose` is told
   * when the socket closed on its own, not when `closeSocket` closed it,
   * so reconnecting, and when, is the caller's.
   */
  openSocket(onFrame: (opened: Opened) => Promise<void> | void, onClose?: () => void): void {
    const uri = this.ws();
    this.closeSocket();
    const socket = new this.WebSocketCtor(uri);
    this.socket = socket;

    socket.onopen = async () => {
      try {
        const plain = plainMessage(LIVE_DELIVERY_CHANGE, this.me, this.mediatorDid, { live_delivery: true });
        const { packed, seal } = await this.pack(plain);
        socket.send(packed);
        await this.traceSeal(seal, await this.traceOut("ws", uri, packed, { type: plain.type }), plain);
      } catch (err) {
        // closing hands the caller its onClose, and the reconnect that goes with it, instead of a socket with live delivery never switched on
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
      try {
        await this.fromMediator(opened);
      } catch (err) {
        this.log(`a socket frame was dropped: ${messageOf(err)}`);
        return;
      }
      this.noteRitual(opened);
      try {
        await onFrame(opened);
      } catch (err) {
        this.log(`a socket frame was not handled: ${messageOf(err)}`);
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
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

  /** A frame going out: its header on `wire`, its bytes on `bytes`; returns the frame's sequence number. */
  async traceOut(via: "http" | "ws", endpoint: string, body: string, extra: TraceData = {}): Promise<number | undefined> {
    const seq = await this.note("wire", "out", { via, endpoint, bytes: utf8Length(body), ...extra });
    if (this.trace.enabled("bytes")) void this.note("bytes", "out", { parent: seq, body });
    return seq;
  }

  /** A frame that came in, the same way; `parent` is the request it answers, when it answers one. */
  async traceIn(via: "http" | "ws", body: string, extra: TraceData = {}): Promise<number | undefined> {
    const seq = await this.note("wire", "in", { via, bytes: utf8Length(body), ...extra });
    if (this.trace.enabled("bytes")) void this.note("bytes", "in", { parent: seq, body });
    return seq;
  }

  /** The `envelope.seal` entry inside `parent`, and the plaintext on `mediation` when it was a ritual with a mediator. */
  async traceSeal(seal: TraceData, parent: number | undefined, plain?: IMessage): Promise<number | undefined> {
    const seq = await this.note("envelope", "seal", { ...seal, parent });
    if (plain !== undefined) void this.note("mediation", "out", { parent: seq, msg: ritual(plain) });
    return seq;
  }

  /** The `envelope.open` entry of an opened envelope, naming the message it ended in when it did. */
  async noteOpen(opened: Opened, messageId?: string): Promise<number | undefined> {
    const seq = await this.note("envelope", "open", messageId === undefined ? opened.open : { ...opened.open, messageId });
    opened.seq = seq;
    return seq;
  }

  /** An opened ritual message from a mediator, in the clear on `mediation`. */
  noteRitual(opened: Opened): void {
    void this.note("mediation", "in", { parent: opened.seq, msg: ritual(opened.msg) });
  }

  /** One entry of the trace. A trace that cannot be written is not a reason to stop sending: the failure is logged and the entry has no number. */
  private async note(stream: TraceStream, what: string, data: TraceData): Promise<number | undefined> {
    try {
      return await this.trace.append(stream, what, data);
    } catch (err) {
      this.log(`trace not written: ${messageOf(err)}`);
      return undefined;
    }
  }

  /** A trace wait that is observability only: losing the race loses the entry alone, and what was won stands. */
  private async noted(signal: AbortSignal | undefined, work: () => Promise<number | undefined>): Promise<number | undefined> {
    if (signal === undefined) return work();
    try {
      return await bounded(signal, work);
    } catch {
      this.log("trace not written: the deadline passed while noting");
      return undefined;
    }
  }
}
