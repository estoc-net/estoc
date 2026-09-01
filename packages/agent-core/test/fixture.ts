import { expect } from "vitest";
import { FromPrior, Message } from "didcomm-node";

import { resolveDIDCommDoc, type DIDDoc } from "@estoc/did-peer";
import { MemoryBackend } from "@estoc/event-store";
import { createSeedKeystore, deriveIdentity, importSeed, type SeedKey } from "@estoc/keystore";
import type { Contact, Delivery } from "@estoc/vault";

import {
  Agent,
  BASIC_MESSAGE,
  Keyring,
  PROFILE,
  attributedTo,
  createVault,
  messageRecord,
  openVault,
  type AgentStatus,
  type ContactRecord,
  type InvitationRecord,
  type MessageRecord,
  type PeerVault,
  type ProtocolHandler,
} from "../src/index.js";
import { FakeMediator, MEDIATOR_HTTP } from "./fake-mediator.js";

/**
 * The scene the v2 agent tests play in: a fake mediator, parties made of
 * a vault and an agent with every event collected, and the projections a
 * test reads — a chat view of the fold, the DID we write to someone
 * from. The vault's clock ticks a second per event, so the canonical
 * order is the order things happened in the test.
 */

export const didcomm = { Message, FromPrior };
export const seedOf = (fill: number) => new Uint8Array(32).map((_, i) => (i * 7 + fill) & 0xff);

export async function newMediator(options: { blobs?: boolean; fill?: number; http?: string; ws?: string } = {}): Promise<FakeMediator> {
  const { blobs, fill, http, ws } = options;
  return new FakeMediator(
    await deriveIdentity(await importSeed(seedOf(fill ?? 200)), "anchor"),
    http ?? MEDIATOR_HTTP,
    ws,
    blobs === undefined ? {} : { blobs }
  );
}

/** every stamp a second after the last: `at` orders what the test appends, whatever the wall clock does */
export function ticking(start = "2026-08-31T00:00:00.000Z"): () => Date {
  let t = new Date(start).getTime();
  return () => new Date((t += 1000));
}

/** A chat projection of the fold for the tests — the shape the app renders. Not part of agent-core. */
export interface ChatMessage {
  mid: string;
  /** the wire message id — dedup key and thread reference */
  id: string;
  kind: "chat" | "profile";
  direction: "sent" | "received";
  /** the counterparty's DID as it was on the wire: the proven sender for inbound, the addressee for outbound */
  contactDid: string;
  /** the contact the message's channel belongs to */
  contactCid?: string;
  content: string;
  /** epoch milliseconds */
  time: number;
}

export function chatView(record: MessageRecord): ChatMessage | null {
  const { msg } = record;
  if (msg === null || (msg.type !== BASIC_MESSAGE && msg.type !== PROFILE)) {
    return null;
  }
  // An inbound record without a proven sender belongs to no thread.
  if (record.direction === "in" && record.sender === null) {
    return null;
  }
  const contactDid = record.direction === "in" ? (record.sender as string) : (msg.to?.[0] ?? "unknown");
  const body = msg.body as { content?: unknown; profile?: { displayName?: unknown } };
  const content =
    msg.type === PROFILE ? (typeof body.profile?.displayName === "string" ? body.profile.displayName : "") : String(body.content ?? "");
  return {
    mid: record.mid,
    id: msg.id,
    kind: msg.type === PROFILE ? "profile" : "chat",
    direction: record.direction === "in" ? "received" : "sent",
    contactDid,
    content,
    time:
      record.direction === "out" || typeof msg.created_time !== "number"
        ? Date.parse(record.at)
        : msg.created_time < 1e12
          ? msg.created_time * 1000
          : msg.created_time,
  };
}

export interface Party {
  name: string;
  backend: MemoryBackend;
  v: PeerVault;
  agent: Agent;
  seedKey: SeedKey;
  /** the vault's clock, carried across a reopen so time never runs backwards */
  clock: () => Date;
  statuses: AgentStatus[];
  messages: { record: MessageRecord; view: ChatMessage }[];
  /** where each tried message stood after the try, per `onDelivery` */
  deliveries: { mid: string; status: Delivery["status"]; attempt: number; error: string | null }[];
  contacts: ContactRecord[];
  invitations: InvitationRecord[];
  log: string[];
  /** resolves when the agent reaches "live" */
  live: Promise<void>;
  /** waits for the next chat-visible message that satisfies `pred` */
  next(pred: (view: ChatMessage) => boolean): Promise<ChatMessage>;
}

export async function newVault(name: string, fill: number, mediatorDid: string | null, backend = new MemoryBackend()) {
  const clock = ticking();
  const { doc, seedKey } = await createSeedKeystore("", { seed: seedOf(fill) });
  const v = await createVault(backend, { label: name, keystore: doc, seedKey, clock });
  if (mediatorDid !== null) {
    // the arrangement `Agent.setMediator` would record, made ahead so `start` runs to live
    const ring = await Keyring.load(v);
    await ring.createMediation(mediatorDid);
  }
  return { backend, v, seedKey, clock };
}

/** What a test swaps out of a party's agent. */
export interface AttachOverrides {
  resolveDid?: (did: string) => Promise<DIDDoc | null>;
  deliveryTimeoutMs?: number;
  maxShareBytes?: number;
  packageTimeoutMs?: number;
  packageFetch?: typeof fetch;
}

export function attach(
  name: string,
  backend: MemoryBackend,
  v: PeerVault,
  seedKey: SeedKey,
  clock: () => Date,
  mediator: Pick<FakeMediator, "fetch" | "WebSocket">,
  handlers: ProtocolHandler[] = [],
  over: AttachOverrides = {}
): Party {
  const party = {
    name,
    backend,
    v,
    seedKey,
    clock,
    statuses: [],
    messages: [],
    deliveries: [],
    contacts: [],
    invitations: [],
    log: [],
  } as unknown as Party;
  let resolveLive!: () => void;
  party.live = new Promise<void>((r) => (resolveLive = r));
  const waiters: { pred: (v: ChatMessage) => boolean; resolve: (v: ChatMessage) => void }[] = [];
  party.next = (pred) => {
    const hit = party.messages.find((m) => pred(m.view));
    if (hit !== undefined) {
      return Promise.resolve(hit.view);
    }
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  };
  party.agent = new Agent({
    vault: v,
    didcomm,
    resolveDid: over.resolveDid ?? resolveDIDCommDoc,
    fetch: mediator.fetch,
    WebSocket: mediator.WebSocket,
    reconnectDelayMs: 10,
    ...(over.deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs: over.deliveryTimeoutMs }),
    ...(over.maxShareBytes === undefined ? {} : { maxShareBytes: over.maxShareBytes }),
    ...(over.packageTimeoutMs === undefined ? {} : { packageTimeoutMs: over.packageTimeoutMs }),
    ...(over.packageFetch === undefined ? {} : { packageFetch: over.packageFetch }),
    handlers,
    events: {
      onStatus(status) {
        party.statuses.push(status);
        if (status.state === "live") {
          resolveLive();
        }
      },
      onMessage(record, contact) {
        const view = chatView(record);
        if (view === null) {
          return;
        }
        if (contact !== null) {
          view.contactCid = contact.cid;
        }
        party.messages.push({ record, view });
        for (const w of [...waiters]) {
          if (w.pred(view)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(view);
          }
        }
      },
      onDelivery(delivery) {
        party.deliveries.push({
          mid: delivery.mid,
          status: delivery.status,
          attempt: delivery.attempts.length,
          error: delivery.attempts.at(-1)?.error ?? null,
        });
      },
      onContact(contact) {
        party.contacts.push(structuredClone(contact));
      },
      onInvitation(invitation) {
        party.invitations.push(structuredClone(invitation));
      },
      onLog(line) {
        party.log.push(line);
      },
    },
  });
  return party;
}

export interface PartyOptions {
  /** false: no mediation recorded — `start` stops at `unmediated` */
  mediated?: boolean;
  handlers?: ProtocolHandler[];
  /** a fetch of the test's own (a flaky line); defaults to the mediator's */
  fetch?: typeof fetch;
  /** a WebSocket of the test's own (counting sockets); defaults to the mediator's */
  webSocket?: typeof WebSocket;
  /** a resolver of the test's own (a DID gone dark); defaults to the package resolver */
  resolveDid?: (did: string) => Promise<DIDDoc | null>;
  /** a budget of the test's own for deliveries, rituals and resolutions */
  deliveryTimeoutMs?: number;
  /** the most block bytes one share may carry inline; defaults to the agent's 1 MiB */
  maxShareBytes?: number;
  /** a budget of the test's own for package transfers */
  packageTimeoutMs?: number;
  /** the fetch that gets a shared package; defaults to the party's fetch */
  packageFetch?: typeof fetch;
  /** a backend of the test's own (a parked trace store); defaults to a fresh MemoryBackend */
  backend?: MemoryBackend;
}

export async function newParty(name: string, fill: number, mediator: FakeMediator, options: PartyOptions = {}): Promise<Party> {
  const { backend, v, seedKey, clock } = await newVault(name, fill, options.mediated === false ? null : mediator.did, options.backend);
  const transports = { fetch: options.fetch ?? mediator.fetch, WebSocket: options.webSocket ?? mediator.WebSocket };
  return attach(name, backend, v, seedKey, clock, transports, options.handlers ?? [], {
    ...(options.resolveDid === undefined ? {} : { resolveDid: options.resolveDid }),
    ...(options.deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs: options.deliveryTimeoutMs }),
    ...(options.maxShareBytes === undefined ? {} : { maxShareBytes: options.maxShareBytes }),
    ...(options.packageTimeoutMs === undefined ? {} : { packageTimeoutMs: options.packageTimeoutMs }),
    ...(options.packageFetch === undefined ? {} : { packageFetch: options.packageFetch }),
  });
}

/** The same vault, opened fresh from its bytes — a page reload. */
export async function reopen(party: Party, mediator: Pick<FakeMediator, "fetch" | "WebSocket">): Promise<Party> {
  party.agent.destroy();
  const v = await openVault(party.backend, party.seedKey, { clock: party.clock });
  return attach(party.name, party.backend, v, party.seedKey, party.clock, mediator);
}

export const withTimeout = <T>(p: Promise<T>, ms = 8000, what = "event"): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms))]);

export async function until(cond: () => boolean): Promise<void> {
  while (!cond()) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A send that could not be delivered: the record is in the log all the
 * same, not sent — its own try failed, or an earlier message to the same
 * contact did and it was not tried behind it — and the latest failure
 * says why. Resolves to the record.
 */
export async function undelivered(party: Party, sending: Promise<MessageRecord>, error?: RegExp): Promise<MessageRecord> {
  const before = party.deliveries.length;
  const found = await sending;
  const own = party.deliveries.filter((e) => e.mid === found.mid).at(-1);
  expect(own?.status ?? "pending").not.toBe("sent");
  const failure = party.deliveries.slice(before).filter((e) => e.status === "failed").at(-1);
  expect(failure).toBeDefined();
  if (error !== undefined) {
    expect(failure?.error).toMatch(error);
  }
  return found;
}

/** The contact who wears `did`, as the fold has it; null for a DID no contact wears. */
export function contactByDid(party: Party, did: string): Contact | null {
  return party.v.fold.contacts().find((contact) => contact.theirDids.some((entry) => entry.did === did)) ?? null;
}

/** The DID `party` currently writes to `contactDid`'s owner from — the latest key toward them. */
export function myDidToward(party: Party, contactDid: string): string {
  const contact = contactByDid(party, contactDid);
  const use = contact?.keys.at(-1);
  const did = use === undefined ? null : (party.v.fold.myKey(use.key)?.minted?.did ?? null);
  if (did === null) {
    throw new Error(`${party.name} has no DID toward ${contactDid.slice(0, 24)}`);
  }
  return did;
}

/** The name of the key of ours that wears `did`. */
export function keyWearing(party: Party, did: string): string {
  const key = party.v.fold.myKeys().find((entry) => entry.minted?.did === did);
  if (key === undefined) {
    throw new Error(`${party.name} holds no key wearing ${did.slice(0, 24)}`);
  }
  return key.key;
}

/** Every message of the fold as a caller reads it, in canonical order. */
export async function recordsOf(party: Party): Promise<MessageRecord[]> {
  const records: MessageRecord[] = [];
  for (const message of party.v.fold.messages()) {
    const found = await messageRecord(party.v.fold, party.v.vault.blobs, message.mid);
    if (found !== null) {
      records.push(found);
    }
  }
  return records;
}

/** Every chat-visible record in log order, homed to its contact through the channels. */
export async function history(party: Party): Promise<ChatMessage[]> {
  const views: ChatMessage[] = [];
  for (const message of party.v.fold.messages()) {
    const found = await messageRecord(party.v.fold, party.v.vault.blobs, message.mid);
    if (found === null) {
      continue;
    }
    const view = chatView(found);
    if (view === null) {
      continue;
    }
    const cid = attributedTo(party.v.fold.attribution(message.pair));
    views.push(cid === null ? view : { ...view, contactCid: cid });
  }
  return views;
}
