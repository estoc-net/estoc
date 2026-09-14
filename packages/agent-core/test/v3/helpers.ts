import { FromPrior, Message } from "didcomm-node";

import { resolveDIDCommDoc, type DIDDoc } from "@estoc/did-peer";
import { openNodeSqlite } from "@estoc/event-store/node";
import type { SqliteDriver } from "@estoc/event-store/v3";
import { createSeedKeystore, deriveIdentity, importSeed, type SeedKey, type SeedKeystoreDocument } from "@estoc/keystore";
import { scanVault, type Did, type MediationId, type VaultEvent } from "@estoc/vault/v3";

import { AgentTrace, Keyring, MediatorLink, createMediation, createVault, type LinkOptions, type OpenedVault } from "../../src/v3/index.js";
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

/** The ring brought up to the vault as it stands now. */
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
