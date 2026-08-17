import { describe, expect, it } from "vitest";
import { createSeedKeystore, importSeed } from "@estoc/keystore";
import { resolveDIDCommDoc } from "@estoc/did-peer";

import {
  CONFIG_PATH,
  ContactStore,
  KEYSTORE_PATH,
  INVITATIONS_DIR,
  KEY_ANCHOR,
  KEY_INVITE_PREFIX,
  KEY_MEDIATION_PREFIX,
  KEY_PAIRWISE_PREFIX,
  DeliveryLog,
  MemoryBackend,
  MessageLog,
  Vault,
  deliveryStatusOf,
  foldDeliveries,
  contactFile,
  currentDid,
  currentMyDid,
  mediationKeyName,
  mintPeerDid,
  newContact,
  newMessageRecord,
  isSegment,
  newSegment,
  orderSegments,
  parseConfig,
  parseInvitation,
  parseInvitationRecord,
  invitationMessage,
  invitationUrl,
  type ContactRecord,
} from "../src/index.js";

const FIXED_SEED = new Uint8Array(32).map((_, i) => i);
const dec = new TextDecoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function freshKeystore() {
  // The seed is fixed for determinism; the passphrase only guards seedJwe,
  // which nothing here opens.
  return createSeedKeystore("test", { seed: FIXED_SEED });
}

describe("Vault", () => {
  it("creates anchor + mediator-facing DID, then reopens with the same DIDs", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const vault = await Vault.create(backend, {
      label: "Alice",
      keystore: doc,
      seedKey,
      mediatorDid: "did:web:mediator.example",
    });
    expect(vault.config.identity.anchor.key).toBe(KEY_ANCHOR);
    expect(vault.config.identity.anchor.did).toMatch(/^did:key:z6Mk/);
    const mediation = vault.config.mediation!;
    expect(mediation.id).toMatch(UUID);
    expect(mediation.me.key).toBe(`${KEY_MEDIATION_PREFIX}${mediation.id}/me`);
    expect(mediation.me.key).toBe(mediationKeyName(mediation.id, "me"));
    expect(mediation.me.did).toMatch(/^did:peer:4/);
    expect(mediation.public).toBeNull();
    expect(vault.keystore.keys.map((k) => k.name)).toEqual([KEY_ANCHOR, mediation.me.key]);

    // Both files landed, and they are the source of truth for a reopen.
    expect(backend.files.has(CONFIG_PATH)).toBe(true);
    expect(backend.files.has(KEYSTORE_PATH)).toBe(true);
    const again = await Vault.open(backend);
    expect(again.config).toEqual(vault.config);

    // The mediator-facing DID re-derives from the seed and matches its snapshot.
    const me = await again.peerIdentity(seedKey, again.config.mediation!.me, null);
    expect(me.did).toBe(vault.config.mediation?.me.did);
    expect(me.secrets.map((s) => s.id)).toEqual([`${me.did}#key-1`, `${me.did}#key-2`]);
  });

  it("pins the anchor and a mediator-facing DID for the fixed seed", async () => {
    // Any change to derivation (`estoc/v3/<purpose>/<name>`) or to the
    // did:peer:4 document shape shows up here. The mediation id is
    // random per vault, so the peer DID is pinned under a fixed name.
    const { doc, seedKey } = await freshKeystore();
    const vault = await Vault.create(new MemoryBackend(), { label: "x", keystore: doc, seedKey });
    expect(vault.config.identity.anchor.did).toBe("did:key:z6Mkk4RzvEvh61iNGk7gJVk9UPSrGofjLgLDrtEqzdCATJ5A");
    const me = mintPeerDid(await vault.derive(seedKey, mediationKeyName("0198b7c0-0000-7000-8000-000000000000", "me")), null);
    const resolved = await resolveDIDCommDoc(me.did);
    expect(resolved?.verificationMethod).toHaveLength(2);
    expect(resolved?.service).toEqual([]);
    expect(me.did.slice(0, 40)).toBe("did:peer:4zQmRG8Tb4SW5rtKZZUwZxTVHAmCy8N");
  });

  it("mints an identity with no mediator, and names one later — same DIDs as naming it at once", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const vault = await Vault.create(backend, { label: "Alice", keystore: doc, seedKey });
    expect(vault.config.mediation).toBeNull();
    expect(vault.keystore.keys.map((k) => k.name)).toEqual([KEY_ANCHOR]);

    // reopened from disk, still unmediated; then the mediator is chosen
    const later = await Vault.open(backend);
    await later.setMediator(seedKey, "did:web:mediator.example");
    const mediation = later.config.mediation!;
    expect(mediation.mediatorDid).toBe("did:web:mediator.example");
    expect(mediation.me.key).toBe(mediationKeyName(mediation.id, "me"));
    expect(mediation.public).toBeNull();
    expect(later.keystore.keys.map((k) => k.name)).toEqual([KEY_ANCHOR, mediation.me.key]);
    expect((await Vault.open(backend)).config).toEqual(later.config);
    // the DID re-derives from its name alone — with or without the cache entry
    expect((await later.peerIdentity(seedKey, mediation.me, null)).did).toBe(mediation.me.did);
    later.keystore = { ...later.keystore, keys: later.keystore.keys.filter((k) => k.name === KEY_ANCHOR) };
    expect((await later.peerIdentity(seedKey, mediation.me, null)).did).toBe(mediation.me.did);

    // every mediation decision gets its own id, hence its own DID: choosing
    // the same mediator on another vault of the same seed does not collide
    const atOnce = await Vault.create(new MemoryBackend(), {
      label: "Alice",
      keystore: (await freshKeystore()).doc,
      seedKey,
      mediatorDid: "did:web:mediator.example",
    });
    expect(atOnce.config.mediation?.id).not.toBe(mediation.id);
    expect(atOnce.config.mediation?.me.did).not.toBe(mediation.me.did);

    // the same mediator again is nothing to do
    await expect(later.setMediator(seedKey, "did:web:mediator.example")).rejects.toThrow(/already reached via/);
  });

  it("changes mediator: a fresh id and fresh me/public keys per mediation, the retired public DID kept on record for the unanswered", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const vault = await Vault.create(backend, { label: "Alice", keystore: doc, seedKey, mediatorDid: "did:web:one" });
    // as the agent would after mediate-grant: a public DID on the routing DID
    const KEY_PUBLIC = mediationKeyName(vault.config.mediation!.id, "public");
    const KEY_MEDIATOR = vault.config.mediation!.me.key;
    const pub = mintPeerDid(await vault.mintKey(seedKey, KEY_PUBLIC), "did:web:one");
    vault.config.mediation = { ...vault.config.mediation!, routingDid: "did:web:one", public: { key: KEY_PUBLIC, did: pub.did } };
    await vault.saveConfig();
    // Bob wrote to the public DID and was never answered; Carol was answered from a pairwise DID (public opens her history); Dan we wrote to first
    const bob = newContact("Bob", "did:peer:4bob");
    bob.addressedAs = pub.did;
    await vault.contacts.put(bob);
    const carol = newContact("Carol", "did:peer:4carol");
    carol.addressedAs = pub.did;
    carol.myDids = [{ did: pub.did, key: KEY_PUBLIC, from: carol.createdAt }];
    await vault.mintPairwise(seedKey, carol, "did:web:one");
    const dan = newContact("Dan", "did:peer:4dan");
    await vault.mintPairwise(seedKey, dan, "did:web:one");

    const before = vault.config.mediation!;
    await vault.setMediator(seedKey, "did:web:two", new Date("2026-08-16T10:00:00Z"));
    const after = vault.config.mediation!;
    expect(after.mediatorDid).toBe("did:web:two");
    expect(after.id).toMatch(UUID);
    expect(after.id).not.toBe(before.id);
    expect(after.me.key).toBe(mediationKeyName(after.id, "me"));
    expect(after.me.did).not.toBe(before.me.did);
    expect(after.routingDid).toBeNull();
    expect(after.public).toBeNull();
    // the old keys stay in the cache — retired DIDs may still have to sign a from_prior
    expect(vault.keystore.keys.map((k) => k.name)).toEqual(
      expect.arrayContaining([KEY_ANCHOR, KEY_MEDIATOR, KEY_PUBLIC, after.me.key])
    );
    // Bob's record now remembers the DID he wrote to, closed at the move
    const bobAfter = (await vault.contacts.byCid(bob.cid))!;
    expect(bobAfter.myDids).toEqual([{ did: pub.did, key: KEY_PUBLIC, from: bob.createdAt, until: "2026-08-16T10:00:00.000Z" }]);
    expect(currentMyDid(bobAfter)).toBeNull();
    // Carol already had it; Dan never knew it: both untouched by the vault (their pairwise DIDs are the agent's to rotate)
    expect((await vault.contacts.byCid(carol.cid))!.myDids).toEqual((carol.myDids ?? []));
    expect((await vault.contacts.byCid(dan.cid))!.myDids).toHaveLength(1);
    // idempotent under a retry, and a third mediation gets a third id
    await expect(vault.setMediator(seedKey, "did:web:two")).rejects.toThrow(/already reached via/);
    await vault.setMediator(seedKey, "did:web:three");
    expect(vault.config.mediation?.id).not.toBe(after.id);
    expect(vault.config.mediation?.me.key).toBe(mediationKeyName(vault.config.mediation!.id, "me"));
    expect((await Vault.open(backend)).config).toEqual(vault.config);
  });

  it("mints pairwise DIDs toward a contact: uuid-named keys, the previous one closed, the record before the cache", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const vault = await Vault.create(backend, { label: "Alice", keystore: doc, seedKey, mediatorDid: "did:web:mediator.example" });
    const routing = "did:web:mediator.example";
    const contact = newContact("Bob", "did:peer:4bob");
    await vault.contacts.put(contact);

    const first = await vault.mintPairwise(seedKey, contact, routing);
    expect(first.did).toMatch(/^did:peer:4/);
    const firstKey = currentMyDid(contact)!.key;
    expect(firstKey.startsWith(`${KEY_PAIRWISE_PREFIX}${contact.cid}/`)).toBe(true);
    expect(firstKey.slice(`${KEY_PAIRWISE_PREFIX}${contact.cid}/`.length)).toMatch(UUID);
    expect(currentMyDid(contact)).toMatchObject({ did: first.did, key: firstKey });
    expect(currentMyDid(contact)?.registeredAt).toBeUndefined();
    // the routing DID is the DID's service; the secrets are the DID's own
    expect((await resolveDIDCommDoc(first.did))?.service[0]?.serviceEndpoint).toMatchObject({ uri: routing });
    expect(first.secrets.map((s) => s.id)).toEqual([`${first.did}#key-1`, `${first.did}#key-2`]);
    // and the record was saved
    expect(currentMyDid((await vault.contacts.byCid(contact.cid)) as ContactRecord)?.did).toBe(first.did);

    // a second one closes the first
    const second = await vault.mintPairwise(seedKey, contact, routing);
    expect(second.did).not.toBe(first.did);
    const secondKey = currentMyDid(contact)!.key;
    expect(secondKey).not.toBe(firstKey);
    expect(contact.myDids?.map((u) => u.key)).toEqual([firstKey, secondKey]);
    expect(contact.myDids?.[0]?.until).toBeDefined();
    expect(currentMyDid(contact)?.did).toBe(second.did);
    // each re-derives from its key ref, checked against the recorded DID
    for (const use of contact.myDids ?? []) {
      await expect(vault.peerIdentity(seedKey, use, routing)).resolves.toMatchObject({ did: use.did });
    }

    // the record is written before the keystore's cache: a crash between
    // the two leaves a contact naming a key the cache has not seen, and
    // the key derives from its name regardless
    const writes: string[] = [];
    const spy = backend.write.bind(backend);
    backend.write = async (path, data) => {
      writes.push(path);
      await spy(path, data);
    };
    const third = await vault.mintPairwise(seedKey, contact, routing);
    expect(writes).toEqual([contactFile(contact.cid), KEYSTORE_PATH]);
    expect(vault.keystore.keys.filter((k) => k.name.startsWith(KEY_PAIRWISE_PREFIX))).toHaveLength(3);
    const thirdKey = currentMyDid(contact)!.key;
    vault.keystore = { ...vault.keystore, keys: vault.keystore.keys.filter((k) => k.name !== thirdKey) };
    await expect(vault.peerIdentity(seedKey, currentMyDid(contact)!, routing)).resolves.toMatchObject({ did: third.did });
    // deterministic: reopening derives the same DIDs
    const again = await Vault.open(backend);
    await expect(again.peerIdentity(seedKey, currentMyDid((await again.contacts.byCid(contact.cid)) as ContactRecord) as { key: string; did: string }, routing)).resolves.toMatchObject({ did: third.did });
  });

  it("issues invitations: a DID under invite/<id>, an open record, a URL that reads back", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const vault = await Vault.create(backend, { label: "Alice", keystore: doc, seedKey, mediatorDid: "did:web:mediator.example" });
    const routing = "did:web:mediator.example";
    const { record, identity } = await vault.createInvitation(seedKey, routing, "Write to Alice");
    expect(record.key).toBe(`${KEY_INVITE_PREFIX}${record.id}`);
    expect(record.did).toBe(identity.did);
    expect(record.acceptedBy).toBeUndefined();
    expect((await resolveDIDCommDoc(record.did))?.service[0]?.serviceEndpoint).toMatchObject({ uri: routing });
    // on disk under its id, and read back by id or DID
    expect(await backend.list(INVITATIONS_DIR)).toEqual([`${record.id}.json`]);
    expect(await vault.invitations.byId(record.id)).toEqual(record);
    expect(await vault.invitations.byDid(record.did)).toEqual(record);
    // reopening derives the same DID from the key ref
    const again = await Vault.open(backend);
    await expect(again.peerIdentity(seedKey, record, routing)).resolves.toMatchObject({ did: record.did });
    expect((await again.invitations.all()).map((i) => i.id)).toEqual([record.id]);
    // the message and its URL round-trip through the parser
    const message = invitationMessage(record);
    expect(message).toMatchObject({ id: record.id, from: record.did, body: { goal_code: "connect", goal: "Write to Alice", accept: ["didcomm/v2"] } });
    expect(parseInvitation(invitationUrl("https://any.host/x", message))).toEqual(message);
    // and the parser refuses what is not an invitation
    expect(() => parseInvitation("did:peer:4abc")).toThrow(/a DID, not an invitation/);
    expect(() => parseInvitation("not base64 at all!")).toThrow(/does not decode/);
    expect(() => parseInvitation("https://any.host/?x=1")).toThrow(/carries no _oob/);
    expect(() => parseInvitation(JSON.stringify({ type: "https://didcomm.org/basicmessage/2.0/message", id: "1", from: "did:x" }))).toThrow(/not an out-of-band/);
    expect(() => parseInvitation(JSON.stringify({ ...message, from: "nope" }))).toThrow(/names no DID/);
    expect(() => parseInvitationRecord(JSON.stringify({ id: "1" }), "1.json")).toThrow(/missing key/);
    // remove
    await again.invitations.remove(record.id);
    expect(await again.invitations.all()).toEqual([]);
    expect(await backend.list(INVITATIONS_DIR)).toEqual([]);
  });

  it("refuses to create over an existing vault, or from a used keystore", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    await Vault.create(backend, { label: "a", keystore: doc, seedKey, mediatorDid: null });
    await expect(
      Vault.create(backend, { label: "b", keystore: doc, seedKey, mediatorDid: null })
    ).rejects.toThrow(/already exists/);
    const used = (await Vault.open(backend)).keystore;
    await expect(
      Vault.create(new MemoryBackend(), { label: "c", keystore: used, seedKey, mediatorDid: null })
    ).rejects.toThrow(/fresh keystore/);
  });

  it("detects a keystore that no longer derives the recorded DID", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const vault = await Vault.create(backend, {
      label: "a",
      keystore: doc,
      seedKey,
      mediatorDid: "did:web:m",
    });
    const otherSeed = await importSeed(new Uint8Array(32).map((_, i) => 31 - i));
    await expect(
      vault.peerIdentity(otherSeed, vault.config.mediation!.me, null)
    ).rejects.toThrow(/does not derive its recorded DID/);
  });

  it("verifyAnchor: the seed in hand must derive the anchor, whether or not the cache lists it", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const vault = await Vault.create(backend, { label: "a", keystore: doc, seedKey, mediatorDid: null });
    await expect(vault.verifyAnchor(seedKey)).resolves.toBeUndefined();
    // a keystore around another seed, with no cache entry to disagree first
    const otherSeed = await importSeed(new Uint8Array(32).map((_, i) => 31 - i));
    vault.keystore = { ...vault.keystore, keys: [] };
    await expect(vault.verifyAnchor(otherSeed)).rejects.toThrow(/does not derive this vault's anchor DID/);
    await expect(vault.verifyAnchor(seedKey)).resolves.toBeUndefined();
  });

  it("mintPeerDid is deterministic and service-sensitive", async () => {
    const { doc, seedKey } = await freshKeystore();
    const vault = await Vault.create(new MemoryBackend(), {
      label: "a",
      keystore: doc,
      seedKey,
      mediatorDid: null,
    });
    const identity = await vault.mintKey(seedKey, "extra");
    const a = mintPeerDid(identity, "did:peer:2.Ez6routing");
    const b = mintPeerDid(identity, "did:peer:2.Ez6routing");
    const c = mintPeerDid(identity, null);
    expect(a.did).toBe(b.did);
    expect(a.did).not.toBe(c.did);
    const doc2 = await resolveDIDCommDoc(a.did);
    expect(doc2?.service[0]?.serviceEndpoint).toEqual({
      uri: "did:peer:2.Ez6routing",
      accept: ["didcomm/v2"],
      routingKeys: [],
    });
    expect(doc2?.keyAgreement).toEqual([`${a.did}#key-2`]);
    expect(vault.keystore.keys.map((k) => k.name)).toEqual([KEY_ANCHOR, "extra"]);
  });
});

describe("config.json", () => {
  const good = {
    format: "estoc",
    version: 1,
    label: "x",
    identity: { anchor: { key: "anchor", did: "did:key:z6Mk" } },
    mediation: null,
  };
  it("round-trips and rejects the malformed", () => {
    expect(parseConfig(JSON.stringify(good))).toEqual(good);
    expect(() => parseConfig("{")).toThrow(/not JSON/);
    expect(() => parseConfig(JSON.stringify({ ...good, format: "git" }))).toThrow(
      /not an estoc/
    );
    expect(() => parseConfig(JSON.stringify({ ...good, version: 2 }))).toThrow(/version/);
    expect(() => parseConfig(JSON.stringify({ ...good, identity: {} }))).toThrow(/anchor/);
    expect(() =>
      parseConfig(JSON.stringify({ ...good, mediation: { mediatorDid: "did:web:m" } }))
    ).toThrow(/mediation/);
    // a mediation without an id is a 0.12 vault, not this format
    expect(() =>
      parseConfig(JSON.stringify({ ...good, mediation: { mediatorDid: "did:web:m", me: { key: "mediator", did: "did:peer:4a" }, routingDid: null, public: null } }))
    ).toThrow(/mediation/);
    const mediated = {
      ...good,
      mediation: {
        id: "0198b7c0-0000-7000-8000-000000000000",
        mediatorDid: "did:web:m",
        me: { key: "mediation/0198b7c0-0000-7000-8000-000000000000/me", did: "did:peer:4a" },
        routingDid: null,
        public: null,
      },
    };
    expect(parseConfig(JSON.stringify(mediated))).toEqual(mediated);
    // fields this version does not know are kept, at every level it rewrites
    const future = {
      ...mediated,
      theme: "dark",
      identity: { ...mediated.identity, avatar: "blob:1" },
      mediation: { ...mediated.mediation, pushEndpoint: "https://x" },
    };
    expect(parseConfig(JSON.stringify(future))).toEqual(future);
  });
});

describe("ContactStore", () => {
  it("puts, finds by any historical DID, keeps one cid-named file through renames, survives reload", async () => {
    const backend = new MemoryBackend();
    const store = new ContactStore(backend);
    const alice = newContact("Alice", "did:peer:4old");
    await store.put(alice);
    expect(await backend.list(".estoc/contacts")).toEqual([`${alice.cid}.json`]);
    expect(contactFile(alice.cid)).toBe(`.estoc/contacts/${alice.cid}.json`);

    // She rotates: the old DID closes, the new one opens with evidence.
    alice.dids[0]!.until = "2026-08-15T00:00:00.000Z";
    alice.dids.push({ did: "did:peer:4new", from: "2026-08-15T00:00:00.000Z", fromPrior: "eyJ" });
    alice.name = "Alice Liddell";
    await store.put(alice);
    expect(await backend.list(".estoc/contacts")).toEqual([`${alice.cid}.json`]);

    const reloaded = new ContactStore(backend);
    expect((await reloaded.byDid("did:peer:4old"))?.cid).toBe(alice.cid);
    expect((await reloaded.byDid("did:peer:4new"))?.cid).toBe(alice.cid);
    expect(currentDid((await reloaded.byCid(alice.cid))!)).toBe("did:peer:4new");
    expect(await reloaded.byDid("did:peer:4nobody")).toBeNull();
    expect((await reloaded.all()).map((c) => c.name)).toEqual(["Alice Liddell"]);
  });

  it("stamps updatedAt on every put, and a record without one is not a contact", async () => {
    const backend = new MemoryBackend();
    const store = new ContactStore(backend);
    const alice = newContact("Alice", "did:peer:4a", new Date(1_000));
    expect(alice.updatedAt).toBe(alice.createdAt);
    await store.put(alice);
    expect(alice.updatedAt > alice.createdAt).toBe(true);
    const { updatedAt: _dropped, ...without } = alice;
    await backend.write(contactFile(alice.cid), new TextEncoder().encode(JSON.stringify(without)));
    await expect(new ContactStore(backend).all()).rejects.toThrow(/updatedAt/);
  });

  it("keeps two contacts with the same petname apart, and removes by cid", async () => {
    const backend = new MemoryBackend();
    const store = new ContactStore(backend);
    const a = newContact("Sam", "did:peer:4a", new Date(1_000));
    const b = newContact("Sam", "did:peer:4b", new Date(2_000));
    await store.put(a);
    await store.put(b);
    expect((await backend.list(".estoc/contacts")).sort()).toEqual([`${a.cid}.json`, `${b.cid}.json`].sort());
    const reloaded = new ContactStore(backend);
    expect((await reloaded.all()).map((c) => c.cid)).toEqual([a.cid, b.cid]);
    await reloaded.remove(a.cid);
    expect(await reloaded.byDid("did:peer:4a")).toBeNull();
    expect(await backend.list(".estoc/contacts")).toEqual([`${b.cid}.json`]);
    await reloaded.remove("no-such-cid");
  });

  it("hands out copies: a field changed without put is not saved and does not leak into the cache", async () => {
    const backend = new MemoryBackend();
    const store = new ContactStore(backend);
    const a = newContact("A", "did:peer:4a");
    await store.put(a);
    const got = (await store.byDid("did:peer:4a")) as ContactRecord;
    got.name = "changed in place";
    expect((await store.byCid(a.cid))?.name).toBe("A");
    expect((await new ContactStore(backend).byCid(a.cid))?.name).toBe("A");
  });
});

describe("MessageLog", () => {
  const msg = (id: string) => ({
    id,
    typ: "application/didcomm-plain+json",
    type: "https://didcomm.org/basicmessage/2.0/message",
    from: "did:peer:4a",
    to: ["did:peer:4b"],
    body: { content: id },
  });

  it("appends lines with time-ordered mids and reads them back", async () => {
    const backend = new MemoryBackend();
    const log = new MessageLog(backend);
    const r1 = newMessageRecord({ direction: "out", msg: msg("1") }, new Date(1_000));
    const r2 = newMessageRecord({ direction: "in", sender: "did:peer:4b", msg: msg("2") }, new Date(2_000));
    await log.append(r1);
    await log.append(r2);
    // one segment, minted on first append, named by a uuidv7 — no numbering
    const [segment, ...rest] = await backend.list(".estoc/messages");
    expect(rest).toEqual([]);
    expect(isSegment(segment!)).toBe(true);
    const raw = dec.decode((await backend.read(`.estoc/messages/${segment}`)) as Uint8Array);
    expect(raw.split("\n")).toHaveLength(3);
    expect(raw.endsWith("\n")).toBe(true);
    expect(await log.read()).toEqual([r1, r2]);
    expect(r1.mid < r2.mid).toBe(true);
    expect(r1.at).toBe("1970-01-01T00:00:01.000Z");
  });

  it("concatenates segments in name order, ignores what is not a segment, and skips a truncated tail", async () => {
    const backend = new MemoryBackend();
    const log = new MessageLog(backend);
    const line = (id: string) => new TextEncoder().encode(JSON.stringify(newMessageRecord({ direction: "in", msg: msg(id) })) + "\n");
    const mine = newMessageRecord({ direction: "out", msg: msg("mine") });
    await log.append(mine);
    const [own] = orderSegments(await backend.list(".estoc/messages"));
    // segments from merges: uuidv7 names, so name order is creation order
    const s2 = newSegment(new Date(Date.now() + 1_000));
    const s3 = newSegment(new Date(Date.now() + 2_000));
    const s4 = newSegment(new Date(Date.now() + 3_000));
    await backend.write(`.estoc/messages/${s3}`, line("three"));
    await backend.write(`.estoc/messages/${s4}`, line("four"));
    await backend.write(`.estoc/messages/${s2}`, line("two"));
    // a stray file in the directory is not history — nor is a numbered file
    // from before segments had ids, nor an uppercase uuid
    await backend.write(".estoc/messages/notes.txt", line("stray"));
    await backend.write(".estoc/messages/0001.jsonl", line("stray-too"));
    await backend.write(`.estoc/messages/${s2.toUpperCase()}`, line("stray-three"));
    // a crash mid-append leaves half a line
    await backend.append(`.estoc/messages/${own}`, new TextEncoder().encode('{"mid":"01'));
    expect((await log.read()).map((r) => r.msg.id)).toEqual(["mine", "two", "three", "four"]);
    expect(orderSegments([s4, "x.jsonl", "0002.jsonl", s2, s3])).toEqual([s2, s3, s4]);
    expect(isSegment("0001.jsonl")).toBe(false);
    expect(newSegment()).toMatch(/^[0-9a-f-]{36}\.jsonl$/);
  });

  it("a later session appends behind the newest segment, so a merge is carried on, not written around", async () => {
    const backend = new MemoryBackend();
    const first = new MessageLog(backend);
    await first.append(newMessageRecord({ direction: "out", msg: msg("1") }));
    const imported = await first.writeSegment([newMessageRecord({ direction: "in", sender: "did:peer:4b", msg: msg("2") })]);
    const later = new MessageLog(backend);
    await later.append(newMessageRecord({ direction: "out", msg: msg("3") }));
    expect(orderSegments(await backend.list(".estoc/messages"))).toHaveLength(2);
    expect(dec.decode((await backend.read(`.estoc/messages/${imported}`)) as Uint8Array).split("\n")).toHaveLength(3);
    expect((await later.read()).map((r) => r.msg.id)).toEqual(["1", "2", "3"]);
    // the instance that opened before the import keeps its own segment
    await first.append(newMessageRecord({ direction: "out", msg: msg("4") }));
    expect((await later.read()).map((r) => r.msg.id)).toEqual(["1", "4", "2", "3"]);
  });

  it("skips a damaged line, reports it, and keeps the rest", async () => {
    const backend = new MemoryBackend();
    const good = newMessageRecord({ direction: "in", msg: msg("x") });
    const segment = newSegment();
    await backend.write(
      `.estoc/messages/${segment}`,
      new TextEncoder().encode('{"nope":true}\n' + JSON.stringify(good) + "\n")
    );
    const damaged: string[] = [];
    const records = await new MessageLog(backend).read((d) => damaged.push(d.where));
    expect(records.map((r) => r.msg.id)).toEqual(["x"]);
    expect(damaged).toEqual([`${segment}:1`]);
  });

  it("does not fuse a cut-short line with the next append", async () => {
    const backend = new MemoryBackend();
    const first = newMessageRecord({ direction: "out", msg: msg("1") });
    await new MessageLog(backend).append(first);
    // the crash: half a line, no terminator
    const [segment] = await backend.list(".estoc/messages");
    await backend.append(`.estoc/messages/${segment}`, new TextEncoder().encode('{"mid":"01'));
    // a fresh log instance (the next session) appends
    const log = new MessageLog(backend);
    const second = newMessageRecord({ direction: "in", sender: "did:peer:4b", msg: msg("2") });
    await log.append(second);
    const damaged: string[] = [];
    expect((await log.read((d) => damaged.push(d.line))).map((r) => r.msg.id)).toEqual(["1", "2"]);
    expect(damaged).toEqual(['{"mid":"01']);
    // and a further append on the same instance stays whole too
    await log.append(newMessageRecord({ direction: "in", sender: "did:peer:4b", msg: msg("3") }));
    expect((await log.read()).map((r) => r.msg.id)).toEqual(["1", "2", "3"]);
  });

  it("serialises concurrent appends so none overwrites another", async () => {
    // a backend whose append yields between reading the size and writing,
    // the way OPFS does — unserialised, two appends would land on one offset
    const backend = new MemoryBackend();
    const inner = backend.append.bind(backend);
    let inFlight = 0;
    let overlapped = false;
    backend.append = async (path, data) => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 1));
      await inner(path, data);
      inFlight--;
    };
    const log = new MessageLog(backend);
    await Promise.all([1, 2, 3, 4, 5].map((i) => log.append(newMessageRecord({ direction: "out", msg: msg(String(i)) }))));
    expect(overlapped).toBe(false);
    expect((await log.read()).map((r) => r.msg.id)).toEqual(["1", "2", "3", "4", "5"]);
  });
});

describe("DeliveryLog", () => {
  it("appends events, skips a damaged line, and folds them into one state per message", async () => {
    const backend = new MemoryBackend();
    const log = new DeliveryLog(backend);
    await log.append({ mid: "m1", at: "2026-08-17T00:00:01.000Z", status: "failed", attempt: 1, error: "fetch failed" });
    await log.append({ mid: "m1", at: "2026-08-17T00:00:02.000Z", status: "sent", attempt: 2, to: "did:peer:4bob" });
    await log.append({ mid: "m2", at: "2026-08-17T00:00:03.000Z", status: "held", attempt: 0, error: "imported" });
    const [segment] = await backend.list(".estoc/deliveries");
    await backend.append(`.estoc/deliveries/${segment}`, new TextEncoder().encode('{"mid":"m3","status":"lost"}\n'));
    const damaged: string[] = [];
    const events = await log.read((d) => damaged.push(d.where));
    expect(events.map((e) => `${e.mid}:${e.status}`)).toEqual(["m1:failed", "m1:sent", "m2:held"]);
    expect(damaged).toEqual([`${segment}:4`]);

    const states = foldDeliveries(events);
    expect(states.get("m1")).toEqual({ status: "sent", attempts: 2, at: "2026-08-17T00:00:02.000Z", to: "did:peer:4bob" });
    expect(states.get("m2")).toEqual({ status: "held", attempts: 0, at: "2026-08-17T00:00:03.000Z", error: "imported" });
    expect(deliveryStatusOf({ mid: "m1", direction: "out" }, states)).toBe("sent");
    expect(deliveryStatusOf({ mid: "m9", direction: "out" }, states)).toBe("pending");
    expect(deliveryStatusOf({ mid: "m1", direction: "in" }, states)).toBeNull();
  });

  it("folds sent as final, and lets time break ties across segments", () => {
    // a merge lays another device's events in a later segment: an older
    // failure there must not shadow our newer sent, and nothing shadows sent
    const states = foldDeliveries([
      { mid: "m1", at: "2026-08-17T00:00:05.000Z", status: "sent", attempt: 2 },
      { mid: "m1", at: "2026-08-17T00:00:01.000Z", status: "failed", attempt: 1, error: "old" },
      { mid: "m1", at: "2026-08-17T00:00:09.000Z", status: "held", attempt: 2 },
      { mid: "m2", at: "2026-08-17T00:00:05.000Z", status: "failed", attempt: 2, error: "later" },
      { mid: "m2", at: "2026-08-17T00:00:01.000Z", status: "failed", attempt: 1, error: "earlier" },
    ]);
    expect(states.get("m1")).toMatchObject({ status: "sent", attempts: 2 });
    expect(states.get("m2")).toMatchObject({ status: "failed", attempts: 2, error: "later" });
  });
});
