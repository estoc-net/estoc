import { FromPrior, Message } from "@estoc/didcomm-node";
import { vi } from "vitest";

import { resolveDIDCommDoc, type DIDDoc, type Secret } from "@estoc/did-peer";
import { openNodeSqlite } from "@estoc/event-store/node";
import type { Cid, Held, JsonObject, SqliteDriver, VaultRuntime } from "@estoc/event-store/v3";
import { createSeedKeystore, deriveIdentity, importSeed, type SeedKey, type SeedKeystoreDocument } from "@estoc/keystore";
import {
  PLAINTEXT_TYP,
  didKeyName,
  inboundMessageId,
  readPlaintext,
  scanVault,
  vaultDraft,
  type Did,
  type DidId,
  type EventReference,
  type MediationId,
  type PublicKey,
  type ReceiptOrdinal,
  type VaultEvent,
  type VaultEventType,
  type WireMessageId,
} from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { PLAIN_TYP, packEncrypted, secretsResolverFor, type DIDResolver, type IMessage } from "../../src/protocol/didcomm.js";
import {
  AgentTrace,
  Keyring,
  MediatorLink,
  authorizedKeys,
  commitResolution,
  configureRoute,
  createDid,
  createMediation,
  createVault,
  ensureRoute,
  establish,
  pinnedResolver,
  resolve,
  type LinkOptions,
  type OpenedVault,
  type Timers,
} from "../../src/v3/index.js";
import { FakeMediator, MEDIATOR_HTTP } from "../fake-mediator.js";

export const didcomm = { Message, FromPrior };
export const seedOf = (fill: number) => new Uint8Array(32).map((_, i) => (i * 7 + fill) & 0xff);
export const PASSPHRASE = "test";

/** A private in-memory database, owned by its one connection. */
export function memoryDriver(): SqliteDriver {
  return openNodeSqlite(":memory:", { mode: "create" });
}

/** every stamp a second after the last: the canonical order is the order things happened in the test */
export function ticking(start = "2026-09-14T00:00:00.000Z"): () => number {
  let t = new Date(start).getTime();
  return () => (t += 1000);
}

export interface Fresh extends OpenedVault {
  seedKey: SeedKey;
  keystore: SeedKeystoreDocument;
}

/** A vault created in `driver` (a private in-memory one by default) under the seed `fill` fills. */
export async function freshVault(fill = 1, label = `party ${fill}`, driver = memoryDriver()): Promise<Fresh> {
  const { doc, seedKey } = await createSeedKeystore(PASSPHRASE, { seed: seedOf(fill) });
  const opened = await createVault(driver, { seedKey, wrapped: doc, label, now: ticking() });
  return { ...opened, seedKey, keystore: doc };
}

export async function newMediator(fill = 200, http = MEDIATOR_HTTP): Promise<FakeMediator> {
  return new FakeMediator(await deriveIdentity(await importSeed(seedOf(fill)), "anchor"), http);
}

export interface Party extends Fresh {
  mediator: FakeMediator;
  mediationId: MediationId;
  created: VaultEvent<"mediation.created">;
  ring: Keyring;
  trace: AgentTrace;
  link: MediatorLink;
  /** what `link` was built from: another link over the same account, or one speaking as another, is `new MediatorLink({ ...linkOptions, ... })` */
  linkOptions: LinkOptions;
  log: string[];
  /** the fetch fails with this while set: the mediator out of reach */
  offline: { reason: string | null };
}

/** A vault with a mediation created toward `mediator` (not yet granted), its ring loaded, and a link over it. */
export async function party(mediator: FakeMediator, fill = 1, over: Partial<LinkOptions> = {}): Promise<Party> {
  const fresh = await freshVault(fill);
  const created = await createMediation(fresh.runtime, fresh.keys, mediator.did as Did);
  const fold = await scanVault(fresh.runtime.vault, fresh.keys);
  const ring = await Keyring.load(fresh.keys, fold);
  const trace = await AgentTrace.open(fresh.runtime.local);
  const log: string[] = [];
  const offline: { reason: string | null } = { reason: null };
  const linkOptions: LinkOptions = {
    didcomm,
    resolveDid: resolveDIDCommDoc,
    fetch: (input, init) => (offline.reason === null ? mediator.fetch(input, init) : Promise.reject(new Error(offline.reason))),
    WebSocket: mediator.WebSocket,
    trace,
    secrets: () => ring.secrets(),
    me: created.data.me.did,
    mediatorDid: mediator.did,
    mediatorDoc: (await resolveDIDCommDoc(mediator.did)) as DIDDoc,
    log: (line) => log.push(line),
    ...over,
  };
  const link = new MediatorLink(linkOptions);
  return { ...fresh, fold, mediator, mediationId: created.data.mediationId, created, ring, trace, link, linkOptions, log, offline };
}

/** Waits for `condition`, giving up after two seconds with `what` in the error. */
export async function until(what: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what}: still not, after two seconds`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function reloaded(p: Pick<Party, "ring" | "runtime" | "keys">): Promise<void> {
  await p.ring.reload(await scanVault(p.runtime.vault, p.keys));
}

/** A `did:web` peer that lives inside the test: its document as a server would publish it, and the secrets behind it. */
export interface WebIdentity {
  did: string;
  document: JsonObject;
  secrets: Secret[];
}

/** A `did:web` identity under `did`, JWK-encoded, with one DIDComm service; the same `fill` gives the same keys under any DID. */
export async function webIdentity(did: string, fill = 77, endpoint = "https://bob.example/didcomm"): Promise<WebIdentity> {
  const jwks = (await deriveIdentity(await importSeed(seedOf(fill)), "anchor")).privateJwks();
  const publicOf = (jwk: JsonWebKey): JsonObject => ({ kty: jwk.kty as string, crv: jwk.crv as string, x: jwk.x as string });
  return {
    did,
    document: {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
      id: did,
      verificationMethod: [
        { id: `${did}#auth`, type: "JsonWebKey2020", controller: did, publicKeyJwk: publicOf(jwks.ed25519) },
        { id: `${did}#agree`, type: "JsonWebKey2020", controller: did, publicKeyJwk: publicOf(jwks.x25519) },
      ],
      authentication: [`${did}#auth`],
      keyAgreement: [`${did}#agree`],
      service: [{ id: `${did}#didcomm`, type: "DIDCommMessaging", serviceEndpoint: { uri: endpoint, accept: ["didcomm/v2"] } }],
    },
    secrets: [
      { id: `${did}#auth`, type: "JsonWebKey2020", privateKeyJwk: { ...jwks.ed25519 } },
      { id: `${did}#agree`, type: "JsonWebKey2020", privateKeyJwk: { ...jwks.x25519 } },
    ],
  };
}

/** A fetch that answers from `routes` by URL and records every URL asked; anything else is 404. */
export function webFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    return route === undefined ? new Response("no such document", { status: 404 }) : route(init);
  };
  return { fetch, calls };
}

export const json = (document: unknown, status = 200): Response => new Response(JSON.stringify(document), { status, headers: { "content-type": "application/did+json" } });

export interface DirectParty extends Fresh {
  didId: DidId;
  did: Did;
  longFormDid: Did;
}

/** A vault created in `driver` with one communication DID, `didId`, on a direct route to `endpoint`. */
export async function directParty(fill: number, endpoint: string, didId: DidId, driver = memoryDriver()): Promise<DirectParty> {
  const fresh = await freshVault(fill, `party ${fill}`, driver);
  const route = await configureRoute(fresh.runtime, fresh.keys, { kind: "direct", endpoint });
  const { minted } = await createDid(fresh.runtime, fresh.keys, route.data.routeId, didId);
  return { ...fresh, didId, did: minted.did, longFormDid: minted.longFormDid };
}

/** Someone who seals: the DID they write as, their secrets, and how the documents they seal against resolve. */
export interface Sealer {
  did: string;
  secrets: Secret[];
  resolver: DIDResolver;
}

/** A peer party sealing as `as` — its long form unless told otherwise — against the documents its own vault answers, which include every numalgo-4 long form. */
export async function peerSealer(holder: DirectParty, as: string = holder.longFormDid): Promise<Sealer> {
  const fold = await scanVault(holder.runtime.vault, holder.keys);
  const ring = await Keyring.load(holder.keys, fold);
  return { did: as, secrets: ring.secrets(), resolver: pinnedResolver(fold) };
}

/** A basic message sealed to `to`: authcrypt from the sealer, anoncrypt without one. */
export async function sealed(from: Sealer | null, to: string, extra: Partial<IMessage> = {}): Promise<string> {
  const plain = { id: crypto.randomUUID(), typ: PLAIN_TYP, type: BASIC_MESSAGE, ...(from === null ? {} : { from: from.did }), to: [to], body: { content: "hello" }, ...extra } as IMessage;
  const [packed] = await packEncrypted(didcomm, plain, to, from?.did ?? null, null, from?.resolver ?? { resolve: resolveDIDCommDoc }, secretsResolverFor(from?.secrets ?? []), { forward: false });
  return packed;
}

export const kidOf = (packed: string): string => (JSON.parse(packed) as { recipients: { header: { kid: string } }[] }).recipients[0]!.header.kid;

/** The peer's message received at one of `party`'s DIDs: the peer's document pinned, the body stored, the observation committed — a complete witness of the peer writing to exactly that address. */
export async function received(party: DirectParty, peer: DirectParty, wire: string, plaintext: Record<string, unknown>, at: { didId: DidId; did: Did } = party): Promise<EventReference<"message.in">> {
  const outcome = await resolve(peer.longFormDid, () => null);
  if (outcome.outcome !== "resolved") throw new Error(outcome.reason);
  const [peerPublicKey] = authorizedKeys(outcome.resolution, "keyAgreement").values();
  const resolved = await commitResolution(party.runtime, { resolution: outcome.resolution, localKeyName: didKeyName(at.didId, "key-agreement"), peerPublicKey: peerPublicKey as PublicKey });
  const read = readPlaintext({ typ: PLAINTEXT_TYP, id: wire, from: peer.longFormDid, to: [at.did], ...plaintext });
  const [event] = await party.runtime.vault.commit(
    [{ cid: read.stored.bodyCid, source: read.stored.bytes }],
    [
      vaultDraft("message.in", {
        messageId: inboundMessageId(peer.did, at.did, wire as WireMessageId),
        wireMessageId: wire as WireMessageId,
        receiptOrdinal: "1" as ReceiptOrdinal,
        intentHash: read.intentHash,
        plaintextHash: read.plaintextHash,
        localKeyName: didKeyName(at.didId, "key-agreement"),
        msgType: read.intent.type,
        peerResolutionEventId: resolved.eventId as EventReference<"peer.resolved">,
        presentedDid: peer.longFormDid,
        did: peer.did,
        thid: read.intent.thid,
        pthid: read.intent.pthid,
        createdTime: read.intent.createdTime,
        expiresTime: read.intent.expiresTime,
        pleaseAck: read.intent.pleaseAck,
        ack: read.intent.ack,
        headers: read.intent.headers,
        fromPrior: null,
        bodyCid: read.stored.bodyCid,
        attachmentCids: read.stored.attachmentCids,
        bytes: 512,
        receivedVia: { mediationId: null, deliveryId: null },
      }),
    ]
  );
  return event!.eventId as EventReference<"message.in">;
}

export interface MediatedParty extends Party {
  didId: DidId;
  did: Did;
  longFormDid: Did;
}

/** A party with its arrangement granted and one communication DID, `didId`, on a route over the mediator: the DID's document sends to the mediator. */
export async function mediatedParty(mediator: FakeMediator, fill: number, didId: DidId): Promise<MediatedParty> {
  const p = await party(mediator, fill);
  await establish(p.link, p.runtime, p.keys, p.mediationId);
  const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
  const { minted } = await createDid(p.runtime, p.keys, routeId, didId);
  return { ...p, didId, did: minted.did, longFormDid: minted.longFormDid };
}

export interface Post {
  url: string;
  body: string;
  init: RequestInit;
}

/** A transport that records every request it is given, in order, and answers each with `answer`. */
export function posting(answer: (post: Post) => Response | Promise<Response>): { fetch: typeof globalThis.fetch; posts: Post[] } {
  const posts: Post[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const post: Post = { url, body: String(init?.body), init: init ?? {} };
    posts.push(post);
    return answer(post);
  };
  return { fetch, posts };
}

export type HandWait = { fire: () => void; ms: number; cleared: boolean };

/** Timers the test fires by hand: every wait set, in order, and whether it was cleared. */
export function handTimers(): Timers & { waits: HandWait[] } {
  const waits: HandWait[] = [];
  return {
    waits,
    set: (fire, ms) => {
      const wait = { fire, ms, cleared: false };
      waits.push(wait);
      return wait;
    },
    clear: (handle) => {
      (handle as HandWait).cleared = true;
    },
  };
}

/** The next `times` commits of a `delivery.submitted` under `runtime` throw: the disk refusing the record of an acceptance the wire gave. */
export function refuseSubmissions(runtime: VaultRuntime, times: number): void {
  refuseCommits(runtime, "delivery.submitted", times);
}

/** The next `times` commits of an event of `type` under `runtime`'s lock throw, as a disk refusing the record would. */
export function refuseCommits(runtime: VaultRuntime, type: VaultEventType, times: number): void {
  let left = times;
  underLock(runtime, (held) =>
    overriding(held, "commit", async (...args: Parameters<Held["commit"]>) => {
      if (left > 0 && args[1].some((draft) => draft.type === type)) {
        left--;
        throw new Error("the disk is full for now");
      }
      return held.commit(...args);
    })
  );
}

/** The next `times` reads of the object `cid` under `runtime`'s lock throw, as a disk refusing the read would; every read of it, by default. */
export function refuseReads(runtime: VaultRuntime, cid: Cid, times = Infinity): void {
  let left = times;
  underLock(runtime, (held) =>
    overriding(
      held,
      "objects",
      overriding(held.objects, "read", async (...args: Parameters<Held["objects"]["read"]>) => {
        if (left > 0 && args[0] === cid) {
          left--;
          throw new Error("the disk refuses the read");
        }
        return held.objects.read(...args);
      })
    )
  );
}

const faults = new WeakMap<VaultRuntime, ((held: Held) => Held)[]>();

/** Every locked step of `runtime` sees `held` through `wrap`, after the wraps installed before it. */
function underLock(runtime: VaultRuntime, wrap: (held: Held) => Held): void {
  let wraps = faults.get(runtime);
  if (wraps === undefined) {
    const installed: ((held: Held) => Held)[] = [];
    faults.set(runtime, installed);
    wraps = installed;
    const locked = runtime.locked.bind(runtime);
    vi.spyOn(runtime, "locked").mockImplementation(((work: (held: Held) => Promise<unknown>) => locked((held) => work(installed.reduce((wrapped, wrap) => wrap(wrapped), held)))) as VaultRuntime["locked"]);
  }
  wraps.push(wrap);
}

function overriding<T extends object>(target: T, key: keyof T, value: unknown): T {
  return new Proxy(target, {
    get(inner, property) {
      if (property === key) return value;
      const found = Reflect.get(inner, property, inner) as unknown;
      return typeof found === "function" ? (found as (...args: unknown[]) => unknown).bind(inner) : found;
    },
  });
}
