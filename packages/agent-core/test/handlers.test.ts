import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { MemoryBackend } from "@estoc/event-store";
import { createSeedKeystore } from "@estoc/keystore";
import { drafts, peerKeyOf, record, recordMessage, type VaultDraft, type VaultEvent, type VaultType } from "@estoc/vault";

import {
  BASIC_MESSAGE,
  GOAL_CONNECT,
  OBJECT_SHARE,
  PLAIN_TYP,
  PROFILE,
  REQUEST_PROFILE,
  basicmessageHandler,
  contactRecord,
  createVault,
  didPlaceholder,
  invitationMessage,
  invitationRecord,
  invitationUrl,
  messageRecord,
  objectShareHandler,
  parseInvitation,
  userProfileHandler,
  type ContactRecord,
  type HandlerContext,
  type InboundRecord,
  type MessageRecord,
  type PeerVault,
  type PlainMessage,
  type SendOptions,
} from "../src/index.js";
import { OOB_INVITATION } from "../src/protocol/spec.js";

const enc = new TextEncoder();
const SEED = new Uint8Array(32).map((_, i) => i);
const ALICE = "did:peer:4zQmAlice000000000000000000000000000000000";
const BOB = "did:peer:4zQmBob0000000000000000000000000000000000000";
const INVITED = "did:peer:4zQmInvite00000000000000000000000000000000";

/** every stamp a second after the last: `at` orders what the test appends, whatever the wall clock does */
function ticking(start = "2026-08-31T00:00:00.000Z"): () => Date {
  let t = new Date(start).getTime();
  return () => new Date((t += 1000));
}

/** a uuidv7-shaped id from a small number */
const uuid = (n: number): string => `0198c000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** a peer's X25519 public key as a document lists it, and its fingerprint */
function peerKey(seedByte: number): { multibase: string; fingerprint: string } {
  const bytes = new Uint8Array(34).fill(seedByte);
  bytes[0] = 0xec;
  bytes[1] = 0x01;
  const multibase = `z${bs58.encode(bytes)}`;
  return { multibase, fingerprint: peerKeyOf(multibase) };
}

const bob = peerKey(7);
const PAIR = { myKey: "did/a", peerKey: bob.fingerprint };
const CID = uuid(50);

async function fresh(): Promise<PeerVault> {
  const { doc, seedKey } = await createSeedKeystore("test", { seed: SEED });
  return createVault(new MemoryBackend(), { keystore: doc, seedKey, label: "Alice", clock: ticking() });
}

const side = (v: PeerVault) => ({ events: v.vault.events, blobs: v.vault.blobs });

/** a key of ours, a channel to Bob on it, and Bob as a contact attached by hand: what a handler is handed */
async function withBob(v: PeerVault): Promise<void> {
  await record(v.vault.events, v.fold, drafts.didMinted({ key: PAIR.myKey, did: ALICE, routingDid: null, mediation: null }));
  await record(v.vault.events, v.fold, drafts.channelFirstSeen({ ...PAIR, peerPublicKey: bob.multibase, kind: "authcrypt", firstDid: BOB }));
  await record(v.vault.events, v.fold, drafts.peerResolved({ ...PAIR, did: BOB, keys: [bob.multibase], service: null }));
  await record(v.vault.events, v.fold, drafts.contactCreated({ cid: CID }));
  await record(v.vault.events, v.fold, drafts.contactAttached({ ...PAIR, cid: CID, because: "manual" }));
}

function contactOf(v: PeerVault, cid = CID): ContactRecord {
  const contact = v.fold.contact(cid);
  if (contact === null) {
    throw new Error(`no contact ${cid}`);
  }
  return contactRecord(contact);
}

let inboundCount = 0;

/** a message from Bob, recorded the way the inbound flow will record it, read back as a handler sees it */
async function arrived(v: PeerVault, type: string, body: Record<string, unknown>): Promise<InboundRecord> {
  const n = ++inboundCount;
  const msg: PlainMessage = { id: `in-${n}`, type, from: BOB, to: [ALICE], body };
  const mid = uuid(n);
  await recordMessage(side(v), v.fold, "in", enc.encode(JSON.stringify(msg)), { ...PAIR, did: BOB, mid, wireId: msg.id, msgType: type, attachments: [] });
  const found = await messageRecord(v.fold, v.vault.blobs, mid);
  if (found === null || found.msg === null || found.direction !== "in") {
    throw new Error(`${mid} did not record as an inbound message`);
  }
  return { ...found, direction: "in", msg: found.msg };
}

interface Stub {
  ctx: HandlerContext;
  /** every draft handed to `record`, in order */
  recorded: VaultDraft[];
  replies: { to: string; type: string; body: Record<string, unknown>; options?: SendOptions }[];
  sent: { cid: string; type: string }[];
  log: string[];
}

let outboundCount = 100;

/** the agent's face, stubbed: `record` appends for real, `reply`/`send` record a `message.out` on the contact's channel and hand it back */
function stub(v: PeerVault, name: () => string = () => "Alice"): Stub {
  const recorded: VaultDraft[] = [];
  const replies: Stub["replies"] = [];
  const sent: Stub["sent"] = [];
  const log: string[] = [];
  const out = async (contact: ContactRecord, type: string, body: Record<string, unknown>, options?: SendOptions): Promise<MessageRecord> => {
    const pair = contact.write ?? PAIR;
    const mid = uuid(outboundCount++);
    const msg: PlainMessage = { id: `out-${mid}`, type, from: ALICE, to: [contact.currentDids.at(-1) ?? ""], body, ...options };
    await recordMessage(side(v), v.fold, "out", enc.encode(JSON.stringify(msg)), { ...pair, mid, wireId: msg.id, msgType: type, attachments: [] });
    const found = await messageRecord(v.fold, v.vault.blobs, mid);
    if (found === null) {
      throw new Error(`${mid} did not record`);
    }
    return found;
  };
  const ctx: HandlerContext = {
    fold: v.fold,
    blobs: v.vault.blobs,
    record: async <T extends VaultType>(draft: VaultDraft<T>): Promise<VaultEvent<T>> => {
      recorded.push(draft);
      return (await record(v.vault.events, v.fold, draft)) as VaultEvent<T>;
    },
    send: (cid, type, body, options) => {
      sent.push({ cid, type });
      return out(contactOf(v, cid), type, body, options);
    },
    reply: (contact, type, body, options) => {
      replies.push({ to: contact.cid, type, body, ...(options === undefined ? {} : { options }) });
      return out(contact, type, body, options);
    },
    displayName: name,
    log: (line) => log.push(line),
  };
  return { ctx, recorded, replies, sent, log };
}

const types = (drafted: VaultDraft[]): string[] => drafted.map((draft) => draft.type);

describe("v2 handlers: user-profile", () => {
  it("introduces us: announces our name, asks for theirs, and records that a profile went out", async () => {
    const v = await fresh();
    await withBob(v);
    const s = stub(v);
    expect(contactOf(v).profileSharedAt).toBeNull();

    await userProfileHandler.introduce?.(contactOf(v), s.ctx);

    expect(s.replies).toEqual([{ to: CID, type: PROFILE, body: { profile: { displayName: "Alice" }, send_back_yours: true } }]);
    const out = v.fold.messages().filter((message) => message.direction === "out");
    expect(out).toHaveLength(1);
    expect(out[0]?.skeleton.msgType).toBe(PROFILE);
    // the observation names the message it rests on, on the channel it went out by
    expect(s.recorded).toEqual([{ type: "profile.shared", data: { ...PAIR, mid: out[0]?.mid } }]);
    const shared = contactOf(v).profileSharedAt;
    expect(shared).not.toBeNull();
    expect(shared as string > (out[0]?.at as string)).toBe(true);
    expect(s.sent).toEqual([]);
    expect(s.log).toEqual([]);
  });

  it("records what they call themself as a claim; the fold shows it until a petname says otherwise", async () => {
    const v = await fresh();
    await withBob(v);
    const s = stub(v);
    expect(contactOf(v).name).toBe(didPlaceholder(BOB));

    const hello = await arrived(v, PROFILE, { profile: { displayName: "Bob B." }, send_back_yours: false });
    await userProfileHandler.onInbound?.(hello, contactOf(v), s.ctx);

    expect(s.recorded).toEqual([{ type: "profile.nameClaimed", data: { ...PAIR, mid: hello.mid, name: "Bob B." } }]);
    expect(contactOf(v)).toMatchObject({ claimedName: "Bob B.", petname: null, name: "Bob B." });
    expect(s.replies).toEqual([]);

    // a petname wins over the claim; a later claim changes the claim, not the name shown
    await record(v.vault.events, v.fold, drafts.contactPetname({ cid: CID, name: "Bobby" }));
    expect(contactOf(v).name).toBe("Bobby");
    const again = await arrived(v, PROFILE, { profile: { displayName: "Robert" } });
    await userProfileHandler.onInbound?.(again, contactOf(v), s.ctx);
    expect(contactOf(v)).toMatchObject({ claimedName: "Robert", petname: "Bobby", name: "Bobby" });
    expect(types(s.recorded)).toEqual(["profile.nameClaimed", "profile.nameClaimed"]);
    expect(s.replies).toEqual([]);
  });

  it("answers send_back_yours once: while no profile of ours has gone out to them", async () => {
    const v = await fresh();
    await withBob(v);
    const s = stub(v);

    const first = await arrived(v, PROFILE, { profile: { displayName: "Bob" }, send_back_yours: true });
    await userProfileHandler.onInbound?.(first, contactOf(v), s.ctx);
    expect(s.replies).toEqual([{ to: CID, type: PROFILE, body: { profile: { displayName: "Alice" }, send_back_yours: true } }]);
    expect(types(s.recorded)).toEqual(["profile.nameClaimed", "profile.shared"]);
    expect(contactOf(v).profileSharedAt).not.toBeNull();

    // they ask again: ours went out already, and the fold says so
    const second = await arrived(v, PROFILE, { profile: { displayName: "Bob" }, send_back_yours: true });
    await userProfileHandler.onInbound?.(second, contactOf(v), s.ctx);
    expect(s.replies).toHaveLength(1);
    expect(types(s.recorded)).toEqual(["profile.nameClaimed", "profile.shared", "profile.nameClaimed"]);
    expect(s.log).toEqual([]);
  });

  it("answers a request-profile without asking back, every time it is asked", async () => {
    const v = await fresh();
    await withBob(v);
    let name = "Alice";
    const s = stub(v, () => name);

    await userProfileHandler.onInbound?.(await arrived(v, REQUEST_PROFILE, {}), contactOf(v), s.ctx);
    expect(s.replies).toEqual([{ to: CID, type: PROFILE, body: { profile: { displayName: "Alice" }, send_back_yours: false } }]);
    expect(s.log).toEqual(["profile requested; sending ours"]);
    expect(types(s.recorded)).toEqual(["profile.shared"]);
    const shared = contactOf(v).profileSharedAt;
    expect(shared).not.toBeNull();

    // asked again after a rename: the name announced is the name now, and the record moves with it
    name = "Alice L.";
    await userProfileHandler.onInbound?.(await arrived(v, REQUEST_PROFILE, {}), contactOf(v), s.ctx);
    expect(s.replies).toHaveLength(2);
    expect(s.replies[1]?.body).toEqual({ profile: { displayName: "Alice L." }, send_back_yours: false });
    expect(types(s.recorded)).toEqual(["profile.shared", "profile.shared"]);
    expect((contactOf(v).profileSharedAt as string) > (shared as string)).toBe(true);
  });

  it("records nothing for a profile that names nothing", async () => {
    const v = await fresh();
    await withBob(v);
    const s = stub(v);

    for (const body of [{ profile: { displayName: "" } }, { profile: {} }, {}, { profile: { displayName: 7 } }, { profile: "Bob" }]) {
      await userProfileHandler.onInbound?.(await arrived(v, PROFILE, body), contactOf(v), s.ctx);
    }

    expect(s.recorded).toEqual([]);
    expect(s.replies).toEqual([]);
    expect(contactOf(v)).toMatchObject({ claimedName: null, name: didPlaceholder(BOB) });
  });
});

describe("v2 handlers: the built-ins", () => {
  it("speak their types; the quiet ones have nothing to do on arrival", () => {
    expect(basicmessageHandler).toEqual({ types: [BASIC_MESSAGE] });
    expect(objectShareHandler).toEqual({ types: [OBJECT_SHARE] });
    expect(userProfileHandler.types).toEqual([PROFILE, REQUEST_PROFILE]);
    expect(typeof userProfileHandler.onInbound).toBe("function");
    expect(typeof userProfileHandler.introduce).toBe("function");
  });
});

describe("v2 oob", () => {
  async function issued(v: PeerVault, key: string, oobId: string, goal: string | null): Promise<string> {
    await record(v.vault.events, v.fold, drafts.didPublished({ key, as: "oob", uses: "one", oobId, ...(goal === null ? {} : { goal }) }));
    return oobId;
  }

  function recordOf(v: PeerVault, oobId: string) {
    const invitation = v.fold.invitations().find((have) => have.oobId === oobId);
    if (invitation === undefined) {
      throw new Error(`no invitation ${oobId}`);
    }
    return invitationRecord(v.fold, invitation);
  }

  it("is the message an issued record stands for, and reads back through a URL", async () => {
    const v = await fresh();
    await record(v.vault.events, v.fold, drafts.didMinted({ key: "did/inv", did: INVITED, routingDid: "did:peer:2.route", mediation: uuid(99) }));
    await issued(v, "did/inv", "oob-1", "Talk to Alice");

    const message = invitationMessage(recordOf(v, "oob-1"));
    expect(message).toEqual({
      type: OOB_INVITATION,
      id: "oob-1",
      typ: PLAIN_TYP,
      from: INVITED,
      body: { goal_code: GOAL_CONNECT, goal: "Talk to Alice", accept: ["didcomm/v2"] },
    });
    expect(parseInvitation(invitationUrl("https://estoc.net/i", message))).toEqual(message);
  });

  it("carries no goal when the record has none, and refuses one whose DID this vault does not hold", async () => {
    const v = await fresh();
    await record(v.vault.events, v.fold, drafts.didMinted({ key: "did/inv", did: INVITED, routingDid: "did:peer:2.route", mediation: uuid(99) }));
    await issued(v, "did/inv", "oob-2", null);
    expect(invitationMessage(recordOf(v, "oob-2")).body).toEqual({ goal_code: GOAL_CONNECT, accept: ["didcomm/v2"] });

    // another device's publish, its mint not merged yet: the record has no DID to hand out
    await issued(v, "did/elsewhere", "oob-3", "Talk");
    expect(recordOf(v, "oob-3").did).toBeNull();
    expect(() => invitationMessage(recordOf(v, "oob-3"))).toThrow("the invitation oob-3 names a DID this vault does not hold yet");
  });
});
