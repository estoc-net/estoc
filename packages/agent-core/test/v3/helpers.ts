import { FromPrior, Message } from "didcomm-node";
import { vi } from "vitest";

import { resolveDIDCommDoc, type DIDDoc, type Secret } from "@estoc/did-peer";
import { openNodeSqlite } from "@estoc/event-store/node";
import type { Held, JsonObject, SqliteDriver, VaultRuntime } from "@estoc/event-store/v3";
import { createSeedKeystore, deriveIdentity, importSeed, type SeedKey, type SeedKeystoreDocument } from "@estoc/keystore";
import { scanVault, type Did, type DidId, type MediationId, type VaultEvent } from "@estoc/vault/v3";

import { AgentTrace, Keyring, MediatorLink, configureRoute, createDid, createMediation, createVault, type LinkOptions, type OpenedVault, type Timers } from "../../src/v3/index.js";
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

/** The next `times` commits of `delivery.submitted` refused, as a disk full for now refuses them; every other commit goes through. */
export function refuseSubmissions(runtime: VaultRuntime, times: number): void {
  const locked = runtime.locked.bind(runtime);
  let left = times;
  const refusing = (held: Held): Held =>
    new Proxy(held, {
      get(target, key) {
        if (key === "commit") {
          return async (...args: Parameters<Held["commit"]>) => {
            if (left > 0 && args[1].some((draft) => draft.type === "delivery.submitted")) {
              left--;
              throw new Error("the disk is full for now");
            }
            return target.commit(...args);
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  vi.spyOn(runtime, "locked").mockImplementation(((work: (held: Held) => Promise<unknown>) => locked((held) => work(refusing(held)))) as VaultRuntime["locked"]);
}

export interface Post {
  url: string;
  body: string;
  init: RequestInit;
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
