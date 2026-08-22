import { Message } from "didcomm-node";
import type { IMessage } from "didcomm-node";
import { encodeLongForm, resolveDIDCommDoc } from "@estoc/did-peer";
import type { Secret } from "@estoc/did-peer";
import bs58 from "bs58";
import { base64urlToBytes, bytesToBase64url } from "@estoc/did-peer";
import type { DerivedIdentity } from "@estoc/keystore";

import { decodeDirNode, verifyCard, type RootCard } from "@estoc/signed-dir";

import {
  DAG_JSON_MEDIA_TYPE,
  DELIVERY,
  DELIVERY_REQUEST,
  FORWARD,
  LIVE_DELIVERY_CHANGE,
  MEDIATE_GRANT,
  MEDIATE_REQUEST,
  MESSAGES_RECEIVED,
  PLAIN_TYP,
  PROBLEM_REPORT,
  PUBLIC_FOLDER_ANSWER,
  PUBLIC_FOLDER_PUBLISH,
  PUBLIC_FOLDER_PUBLISHED,
  PUBLIC_FOLDER_PUBLISH_RESULT,
  PUBLIC_FOLDER_QUERY,
  RAW_MEDIA_TYPE,
  RECIPIENT_UPDATE,
  RECIPIENT_UPDATE_RESPONSE,
  STATUS,
  STATUS_REQUEST,
  authenticationKeyOf,
  decodeCard,
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
  /** the relay role: owner DID → current card (compact JWS) */
  readonly cards = new Map<string, string>();
  /** the relay's object store, CID → bytes */
  readonly objects = new Map<string, Uint8Array>();
  /** every CID received as a publish attachment, in order — for incremental-push assertions */
  readonly receivedObjects: string[] = [];
  /** answer attachments above this many bytes go by link instead of inline */
  answerInlineLimit = 256 * 1024;
  /** `retain_until` for published receipts (REQUIRED by spec — a never-collecting relay states a generous bound) */
  retainUntil = "2099-01-01T00:00:00Z";
  /** the fake `fetch`: the mediator's endpoint, or 404 */
  readonly fetch: typeof fetch;
  /** the fake `WebSocket` constructor bound to this mediator */
  readonly WebSocket: typeof WebSocket;

  /** Two mediators in one test tell apart by their endpoints; see `network`. */
  constructor(
    identity: DerivedIdentity,
    readonly http = MEDIATOR_HTTP,
    readonly wsUrl = MEDIATOR_WS
  ) {
    const minted = mintMediatorIdentity(identity, http, wsUrl);
    this.did = minted.did;
    this.secrets = minted.secrets;
    this.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === this.http) {
        const reply = await this.handleHttp(String(init?.body));
        return reply === null
          ? new Response(null, { status: 202 })
          : new Response(reply, { status: 200, headers: { "content-type": "application/didcomm-encrypted+json" } });
      }
      // the relay's trustless read endpoints, GET only
      if (url.startsWith(`${this.http}objects/`)) {
        const bytes = this.objects.get(url.slice(`${this.http}objects/`.length));
        return bytes === undefined
          ? new Response("not found", { status: 404 })
          : new Response(bytes.slice() as unknown as BodyInit, { status: 200 });
      }
      if (url.startsWith(`${this.http}card/`)) {
        const did = decodeURIComponent(url.slice(`${this.http}card/`.length));
        const jws = this.cards.get(did);
        return jws === undefined
          ? new Response("not found", { status: 404 })
          : new Response(jws, { status: 200, headers: { "content-type": "application/jose" } });
      }
      return new Response("not found", { status: 404 });
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
      case PUBLIC_FOLDER_PUBLISH:
        return this.handlePublish(msg, from as string);
      case PUBLIC_FOLDER_QUERY:
        return this.handleQuery(msg, from as string);
      default:
        throw new Error(`fake mediator cannot handle ${msg.type}`);
    }
  }

  /**
   * The relay role of public-folder/1.0, just enough of it: verify the
   * card, take the attached objects, report what is missing under the
   * root, serve the proof chain back. No policy, no refcounts, no purge.
   */
  private async handlePublish(msg: IMessage, from: string): Promise<IMessage> {
    const jws = (msg.body as { card?: unknown }).card;
    if (typeof jws !== "string") {
      return this.reply(PROBLEM_REPORT, from, { code: "e.p.card.invalid", comment: "no card" }, msg.id);
    }
    let card: RootCard;
    try {
      ({ card } = await verifyCard(jws, async (kid) => {
        const did = didOf(kid);
        const doc = did === null ? null : await resolveDIDCommDoc(did);
        return doc === null ? null : authenticationKeyOf(doc, kid);
      }));
    } catch (err) {
      return this.reply(
        PROBLEM_REPORT,
        from,
        { code: "e.p.card.invalid", comment: err instanceof Error ? err.message : String(err) },
        msg.id
      );
    }
    for (const attachment of msg.attachments ?? []) {
      const { id, data } = attachment as { id?: string; data?: { base64?: string } };
      if (typeof id === "string" && typeof data?.base64 === "string") {
        this.objects.set(id, base64urlToBytes(data.base64));
        this.receivedObjects.push(id);
      }
    }
    if (card.root !== null) {
      const missing = this.missingFrom(card.root);
      if (missing.length > 0) {
        return this.reply(PUBLIC_FOLDER_PUBLISH_RESULT, from, { missing }, msg.id);
      }
    }
    this.cards.set(card.did, jws);
    return this.reply(
      PUBLIC_FOLDER_PUBLISHED,
      from,
      {
        did: card.did,
        card_id: card.id,
        retain_until: this.retainUntil,
      },
      msg.id
    );
  }

  /** CIDs reachable from `root` that the store does not hold — an absent directory node hides its subtree. */
  private missingFrom(root: string): string[] {
    const missing: string[] = [];
    const seen = new Set<string>([root]);
    const dirs = [root];
    while (dirs.length > 0) {
      const cid = dirs.shift() as string;
      const bytes = this.objects.get(cid);
      if (bytes === undefined) {
        missing.push(cid);
        continue;
      }
      for (const entry of decodeDirNode(bytes)) {
        if (seen.has(entry.hash)) {
          continue;
        }
        seen.add(entry.hash);
        if (entry.type === "dir") {
          dirs.push(entry.hash);
        } else if (!this.objects.has(entry.hash)) {
          missing.push(entry.hash);
        }
      }
    }
    return missing;
  }

  private async handleQuery(msg: IMessage, from: string): Promise<IMessage> {
    const body = msg.body as { did?: string; path?: string; card_only?: boolean };
    const jws = typeof body.did === "string" ? this.cards.get(body.did) : undefined;
    if (jws === undefined) {
      return this.reply(
        PROBLEM_REPORT,
        from,
        { code: "e.p.did.unknown", comment: `This relay holds no card for ${body.did}` },
        msg.id
      );
    }
    const card = decodeCard(jws);
    if (card.root === null || body.card_only === true) {
      return this.reply(PUBLIC_FOLDER_ANSWER, from, { card: jws }, msg.id);
    }
    const chain: { cid: string; bytes: Uint8Array; dir: boolean }[] = [];
    let cid = card.root;
    let dir = true;
    const segments =
      typeof body.path === "string" && body.path !== "" ? body.path.split("/") : [];
    for (;;) {
      const bytes = this.objects.get(cid);
      if (bytes === undefined) {
        return this.reply(PROBLEM_REPORT, from, { code: "e.p.me.res.storage" }, msg.id);
      }
      chain.push({ cid, bytes, dir });
      const segment = segments.shift();
      if (segment === undefined) {
        break;
      }
      const entry = dir ? decodeDirNode(bytes).find((e) => e.name === segment) : undefined;
      if (entry === undefined) {
        return this.reply(
          PROBLEM_REPORT,
          from,
          { code: "e.p.path.not-found", comment: `No such path: ${body.path}` },
          msg.id
        );
      }
      cid = entry.hash;
      dir = entry.type === "dir";
    }
    return {
      ...this.reply(PUBLIC_FOLDER_ANSWER, from, { card: jws }, msg.id),
      attachments: chain.map(({ cid, bytes, dir }) => ({
        id: cid,
        media_type: dir ? DAG_JSON_MEDIA_TYPE : RAW_MEDIA_TYPE,
        data:
          bytes.length <= this.answerInlineLimit
            ? { base64: bytesToBase64url(bytes) }
            : // didcomm-rust requires `hash` on links data; readers here verify
              // by the CID on every hop, so the CID stands in for the multihash
              { links: [`${this.http}objects/${cid}`], hash: cid },
      })),
    } as IMessage;
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
    const owner = mediators.find((m) => url.startsWith(m.http));
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
