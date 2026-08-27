import { Message } from "didcomm-node";
import type { IMessage } from "didcomm-node";
import { encodeLongForm, resolveDIDCommDoc } from "@estoc/did-peer";
import type { Secret } from "@estoc/did-peer";
import bs58 from "bs58";
import { base64urlToBytes } from "@estoc/did-peer";
import type { DerivedIdentity } from "@estoc/keystore";

import {
  BLOB_PUT,
  BLOB_PUT_RESULT,
  BLOB_DELETE,
  BLOB_DELETE_RESULT,
  DELIVERY,
  DELIVERY_REQUEST,
  FORWARD,
  LIVE_DELIVERY_CHANGE,
  MEDIATE_GRANT,
  MEDIATE_REQUEST,
  MESSAGES_RECEIVED,
  PLAIN_TYP,
  RECIPIENT_UPDATE,
  RECIPIENT_UPDATE_RESPONSE,
  STATUS,
  STATUS_REQUEST,
  didOf,
  secretsResolverFor,
} from "../src/index.js";

/**
 * A mediator that lives inside the test: coordinate-mediation 3.0,
 * messagepickup 3.0 (HTTP and a fake WebSocket), routing 2.0 forward.
 * It speaks the same wire shapes as mediator-ts's demo-interop test pins,
 * minus everything an in-process double does not need (auth, persistence,
 * problem reports).
 */

export const MEDIATOR_HTTP = "http://fake-mediator/";
const PROBLEM_REPORT = "https://didcomm.org/report-problem/2.0/problem-report";
/** the fake store's blob cap — small, so a test can hit it */
export const BLOB_MAX = 64 * 1024;
export const MEDIATOR_WS = "ws://fake-mediator/ws";

const resolver = { resolve: resolveDIDCommDoc };

function multibase(prefix: number[], key: Uint8Array): string {
  const bytes = new Uint8Array(prefix.length + key.length);
  bytes.set(prefix);
  bytes.set(key, prefix.length);
  return `z${bs58.encode(bytes)}`;
}

/** A did:peer:4 with both an HTTP and a WebSocket service. */
export function mintMediatorIdentity(
  identity: DerivedIdentity,
  http = MEDIATOR_HTTP,
  ws = MEDIATOR_WS
): { did: string; secrets: Secret[] } {
  const jwks = identity.privateJwks();
  const did = encodeLongForm({
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    verificationMethod: [
      { id: "#key-1", type: "Multikey", publicKeyMultibase: multibase([0xed, 0x01], base64urlToBytes(jwks.ed25519.x as string)) },
      { id: "#key-2", type: "Multikey", publicKeyMultibase: multibase([0xec, 0x01], base64urlToBytes(jwks.x25519.x as string)) },
    ],
    authentication: ["#key-1"],
    keyAgreement: ["#key-2"],
    service: [
      { id: "#http", type: "DIDCommMessaging", serviceEndpoint: { uri: http, accept: ["didcomm/v2"] } },
      { id: "#ws", type: "DIDCommMessaging", serviceEndpoint: { uri: ws, accept: ["didcomm/v2"] } },
    ],
  });
  return {
    did,
    secrets: [
      { id: `${did}#key-1`, type: "JsonWebKey2020", privateKeyJwk: { ...jwks.ed25519 } },
      { id: `${did}#key-2`, type: "JsonWebKey2020", privateKeyJwk: { ...jwks.x25519 } },
    ],
  };
}

interface Queued {
  id: string;
  packed: string;
}

/** A blob the fake store knows: its declared size, its bytes once uploaded, and the live upload token. */
interface FakeBlob {
  size: number;
  bytes: Uint8Array | null;
  token: string | null;
}

export class FakeSocket {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  closed = false;

  constructor(
    private readonly mediator: FakeMediator,
    readonly url: string
  ) {
    setTimeout(() => this.onopen?.({}), 0);
  }

  send(text: string): void {
    void this.mediator.handleWs(this, text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.mediator.socketClosed(this);
    this.onclose?.({});
  }

  /** the mediator pushing a frame down */
  deliver(text: string): void {
    this.onmessage?.({ data: text });
  }
}

export class FakeMediator {
  readonly did: string;
  private readonly secrets: Secret[];
  /** recipient DID → account (mediator-facing) DID */
  readonly recipients = new Map<string, string>();
  readonly queues = new Map<string, Queued[]>();
  private readonly sockets = new Map<string, FakeSocket>();
  /** every plaintext type the mediator handled, in order — for assertions */
  readonly seenTypes: string[] = [];
  /** blob-store/1.0 when on: hash → blob; off, `put` is refused */
  readonly blobs: Map<string, FakeBlob> | null;
  /** the fake `fetch`: the mediator's endpoint, or 404 */
  readonly fetch: typeof fetch;
  /** the fake `WebSocket` constructor bound to this mediator */
  readonly WebSocket: typeof WebSocket;

  /** Two mediators in one test tell apart by their endpoints; see `network`. */
  constructor(
    identity: DerivedIdentity,
    readonly http = MEDIATOR_HTTP,
    readonly wsUrl = MEDIATOR_WS,
    options: { blobs?: boolean } = {}
  ) {
    const minted = mintMediatorIdentity(identity, http, wsUrl);
    this.did = minted.did;
    this.secrets = minted.secrets;
    this.blobs = options.blobs ? new Map() : null;
    this.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(`${this.http}b/`)) {
        return this.handleBlob(url, init);
      }
      if (url !== this.http) {
        return new Response("not found", { status: 404 });
      }
      const reply = await this.handleHttp(String(init?.body));
      return reply === null
        ? new Response(null, { status: 202 })
        : new Response(reply, { status: 200, headers: { "content-type": "application/didcomm-encrypted+json" } });
    }) as typeof fetch;
    const mediator = this;
    this.WebSocket = class extends FakeSocket {
      constructor(url: string) {
        super(mediator, url);
      }
    } as unknown as typeof WebSocket;
  }

  private async unpack(text: string): Promise<{ msg: IMessage; from: string | null }> {
    const [msg, meta] = await Message.unpack(text, resolver, secretsResolverFor(this.secrets), {});
    return { msg: msg.as_value(), from: didOf(meta.encrypted_from_kid) };
  }

  private async pack(msg: IMessage, to: string): Promise<string> {
    const [packed] = await new Message(msg).pack_encrypted(
      to,
      this.did,
      null,
      resolver,
      secretsResolverFor(this.secrets),
      { forward: false }
    );
    return packed;
  }

  private reply(type: string, to: string, body: Record<string, unknown>, thid?: string): IMessage {
    return {
      id: crypto.randomUUID(),
      typ: PLAIN_TYP,
      type,
      from: this.did,
      to: [to],
      created_time: Math.floor(Date.now() / 1000),
      ...(thid === undefined ? {} : { thid }),
      body,
    } as IMessage;
  }

  private queue(account: string): Queued[] {
    let q = this.queues.get(account);
    if (q === undefined) {
      q = [];
      this.queues.set(account, q);
    }
    return q;
  }

  private deliveryFor(account: string, items: Queued[]): IMessage {
    return {
      ...this.reply(DELIVERY, account, { recipient_did: account }),
      attachments: items.map((item) => ({ id: item.id, data: { json: JSON.parse(item.packed) } })),
    } as IMessage;
  }

  /** Handle one plaintext from `from`; the reply plaintext, or null for none. */
  private async dispatch(msg: IMessage, from: string | null): Promise<IMessage | null> {
    this.seenTypes.push(msg.type);
    switch (msg.type) {
      case FORWARD: {
        const next = (msg.body as { next?: string }).next;
        const account = next === undefined ? undefined : this.recipients.get(next);
        if (account === undefined) {
          throw new Error(`forward for unknown recipient ${next}`);
        }
        const attachments = (msg.attachments ?? []) as { data: { json?: unknown } }[];
        const items: Queued[] = attachments.map((a) => ({
          id: crypto.randomUUID(),
          packed: JSON.stringify(a.data.json),
        }));
        this.queue(account).push(...items);
        const socket = this.sockets.get(account);
        if (socket !== undefined) {
          socket.deliver(await this.pack(this.deliveryFor(account, items), account));
        }
        return null;
      }
      case MEDIATE_REQUEST:
        return this.reply(MEDIATE_GRANT, from as string, { routing_did: [this.did] }, msg.id);
      case RECIPIENT_UPDATE: {
        const updates = (msg.body as { updates: { recipient_did: string; action: string }[] }).updates;
        const updated = updates.map((u) => {
          if (u.action === "add") {
            const had = this.recipients.get(u.recipient_did);
            this.recipients.set(u.recipient_did, from as string);
            return { ...u, result: had === from ? "no_change" : "success" };
          }
          this.recipients.delete(u.recipient_did);
          return { ...u, result: "success" };
        });
        return this.reply(RECIPIENT_UPDATE_RESPONSE, from as string, { updated }, msg.id);
      }
      case STATUS_REQUEST:
        return this.reply(STATUS, from as string, { message_count: this.queue(from as string).length }, msg.id);
      case DELIVERY_REQUEST: {
        const limit = (msg.body as { limit?: number }).limit ?? 10;
        const items = this.queue(from as string).slice(0, limit);
        if (items.length === 0) {
          return this.reply(STATUS, from as string, { message_count: 0 }, msg.id);
        }
        return { ...this.deliveryFor(from as string, items), thid: msg.id } as IMessage;
      }
      case MESSAGES_RECEIVED: {
        const ids = new Set((msg.body as { message_id_list: string[] }).message_id_list);
        const q = this.queue(from as string);
        this.queues.set(from as string, q.filter((item) => !ids.has(item.id)));
        return this.reply(STATUS, from as string, { message_count: this.queue(from as string).length }, msg.id);
      }
      case LIVE_DELIVERY_CHANGE:
        return this.reply(STATUS, from as string, { live_delivery: (msg.body as { live_delivery: boolean }).live_delivery }, msg.id);
      case BLOB_PUT: {
        const { hash, size } = msg.body as { hash: string; size: number };
        if (this.blobs === null) {
          return this.reply(PROBLEM_REPORT, from as string, { code: "e.p.blob.refused", comment: "this mediator does not store blobs" }, msg.id);
        }
        if (size > BLOB_MAX) {
          return this.reply(PROBLEM_REPORT, from as string, { code: "e.p.blob.too-large", comment: `at most ${BLOB_MAX} bytes` }, msg.id);
        }
        let blob = this.blobs.get(hash);
        if (blob === undefined) {
          blob = { size, bytes: null, token: null };
          this.blobs.set(hash, blob);
        }
        const url = `${this.http}b/${hash}`;
        const body: Record<string, unknown> = { hash, url, retain_until: new Date(Date.now() + 3600_000).toISOString() };
        if (blob.bytes === null) {
          blob.token = crypto.randomUUID();
          body.upload = { url: `${url}?token=${blob.token}`, expires: new Date(Date.now() + 3600_000).toISOString() };
        }
        return this.reply(BLOB_PUT_RESULT, from as string, body, msg.id);
      }
      case BLOB_DELETE: {
        const { hash } = msg.body as { hash: string };
        this.blobs?.delete(hash);
        return this.reply(BLOB_DELETE_RESULT, from as string, { hash }, msg.id);
      }
      default:
        throw new Error(`fake mediator cannot handle ${msg.type}`);
    }
  }

  /** `PUT /b/<hash>?token=…` with the bytes; `GET /b/<hash>` for anyone, 404 unless uploaded. */
  private async handleBlob(url: string, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    const hash = parsed.pathname.slice("/b/".length);
    const blob = this.blobs?.get(hash);
    if ((init?.method ?? "GET") === "PUT") {
      const token = parsed.searchParams.get("token");
      if (blob === undefined || token === null || token !== blob.token) {
        return new Response("no such upload", { status: 404 });
      }
      const bytes = new Uint8Array(await new Request(url, { method: "PUT", body: init?.body as BodyInit }).arrayBuffer());
      if (bytes.length !== blob.size) {
        return new Response(`expected ${blob.size} bytes`, { status: 400 });
      }
      blob.bytes = bytes;
      blob.token = null;
      return new Response(null, { status: 204 });
    }
    if (blob === undefined || blob.bytes === null) {
      return new Response("no such blob", { status: 404 });
    }
    return new Response(blob.bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
  }

  async handleHttp(text: string): Promise<string | null> {
    const { msg, from } = await this.unpack(text);
    const reply = await this.dispatch(msg, from);
    return reply === null ? null : this.pack(reply, from as string);
  }

  async handleWs(socket: FakeSocket, text: string): Promise<void> {
    const { msg, from } = await this.unpack(text);
    if (msg.type === LIVE_DELIVERY_CHANGE && from !== null) {
      this.sockets.set(from, socket);
    }
    const reply = await this.dispatch(msg, from);
    if (reply !== null) {
      socket.deliver(await this.pack(reply, from as string));
    }
  }

  /** The mediator dropping an account's socket — an outage seen from the client. */
  dropSocket(account: string): void {
    this.sockets.get(account)?.close();
  }

  socketClosed(socket: FakeSocket): void {
    for (const [account, s] of this.sockets) {
      if (s === socket) {
        this.sockets.delete(account);
      }
    }
  }
}

/**
 * Several mediators reachable from one agent: a `fetch` and a `WebSocket`
 * that route by URL to whichever mediator owns the endpoint.
 */
export function network(...mediators: FakeMediator[]): Pick<FakeMediator, "fetch" | "WebSocket"> {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const owner = mediators.find((m) => m.http === url);
    return owner === undefined ? new Response("not found", { status: 404 }) : owner.fetch(input, init);
  }) as typeof fetch;
  const WebSocketCtor = class {
    constructor(url: string) {
      const owner = mediators.find((m) => m.wsUrl === url);
      if (owner === undefined) {
        throw new Error(`no mediator listens at ${url}`);
      }
      return new owner.WebSocket(url);
    }
  } as unknown as typeof WebSocket;
  return { fetch: fetchFn, WebSocket: WebSocketCtor };
}
