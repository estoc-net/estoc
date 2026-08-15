import { describe, expect, it } from "vitest";
import { createSeedKeystore, importSeed } from "@estoc/keystore";
import { resolveDIDCommDoc } from "@estoc/did-peer";

import {
  CONFIG_PATH,
  ContactStore,
  KEYSTORE_PATH,
  KEY_ANCHOR,
  KEY_MEDIATOR,
  MemoryBackend,
  MessageLog,
  Vault,
  contactFileStem,
  currentDid,
  mintPeerDid,
  newContact,
  newMessageRecord,
  parseConfig,
  type ContactRecord,
} from "../src/index.js";

const FIXED_SEED = new Uint8Array(32).map((_, i) => i);
const dec = new TextDecoder();

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
    expect(vault.config.mediation?.me.key).toBe(KEY_MEDIATOR);
    expect(vault.config.mediation?.me.did).toMatch(/^did:peer:4/);
    expect(vault.config.mediation?.public).toBeNull();
    expect(vault.keystore.keys.map((k) => k.name)).toEqual([KEY_ANCHOR, KEY_MEDIATOR]);

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

  it("pins the mediator-facing DID for the fixed seed", async () => {
    // Index 1 of FIXED_SEED, no service. Any change to derivation or to the
    // did:peer:4 document shape shows up here.
    const { doc, seedKey } = await freshKeystore();
    const vault = await Vault.create(new MemoryBackend(), {
      label: "x",
      keystore: doc,
      seedKey,
      mediatorDid: "did:web:m",
    });
    const did = vault.config.mediation!.me.did;
    const resolved = await resolveDIDCommDoc(did);
    expect(resolved?.verificationMethod).toHaveLength(2);
    expect(resolved?.service).toEqual([]);
    expect(did.slice(0, 40)).toBe("did:peer:4zQmTKyYhKfZg48DSSVAL1bcba2AYPC");
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
    expect(later.config.mediation?.mediatorDid).toBe("did:web:mediator.example");
    expect(later.config.mediation?.me.key).toBe(KEY_MEDIATOR);
    expect(later.config.mediation?.public).toBeNull();
    expect(later.keystore.keys.map((k) => k.name)).toEqual([KEY_ANCHOR, KEY_MEDIATOR]);
    expect((await Vault.open(backend)).config).toEqual(later.config);

    // choosing later or at creation lands on the same mediator-facing DID
    const atOnce = await Vault.create(new MemoryBackend(), {
      label: "Alice",
      keystore: (await freshKeystore()).doc,
      seedKey,
      mediatorDid: "did:web:mediator.example",
    });
    expect(atOnce.config.mediation?.me.did).toBe(later.config.mediation?.me.did);

    // a mediator, once named, is not swapped behind the public DID's back
    await expect(later.setMediator(seedKey, "did:web:other")).rejects.toThrow(/already has a mediator/);
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
    const mediated = {
      ...good,
      mediation: {
        mediatorDid: "did:web:m",
        me: { key: "mediator", did: "did:peer:4a" },
        routingDid: null,
        public: null,
      },
    };
    expect(parseConfig(JSON.stringify(mediated))).toEqual(mediated);
  });
});

describe("ContactStore", () => {
  it("puts, finds by any historical DID, renames the file, survives reload", async () => {
    const backend = new MemoryBackend();
    const store = new ContactStore(backend);
    const alice = newContact("Alice", "did:peer:4old");
    await store.put(alice);
    expect(await backend.list(".estoc/contacts")).toEqual(["Alice.json"]);

    // She rotates: the old DID closes, the new one opens with evidence.
    alice.dids[0]!.until = "2026-08-15T00:00:00.000Z";
    alice.dids.push({ did: "did:peer:4new", from: "2026-08-15T00:00:00.000Z", fromPrior: "eyJ" });
    alice.name = "Alice Liddell";
    await store.put(alice);
    expect(await backend.list(".estoc/contacts")).toEqual(["Alice_Liddell.json"]);

    const reloaded = new ContactStore(backend);
    expect((await reloaded.byDid("did:peer:4old"))?.cid).toBe(alice.cid);
    expect((await reloaded.byDid("did:peer:4new"))?.cid).toBe(alice.cid);
    expect(currentDid((await reloaded.byCid(alice.cid))!)).toBe("did:peer:4new");
    expect(await reloaded.byDid("did:peer:4nobody")).toBeNull();
    expect((await reloaded.all()).map((c) => c.name)).toEqual(["Alice Liddell"]);
  });

  it("keeps two contacts with the same petname in different files", async () => {
    const backend = new MemoryBackend();
    const store = new ContactStore(backend);
    const a = newContact("Sam", "did:peer:4a", new Date(1_000));
    const b = newContact("Sam", "did:peer:4b", new Date(2_000));
    await store.put(a);
    await store.put(b);
    const files = (await backend.list(".estoc/contacts")).sort();
    expect(files).toEqual(["Sam.json", `Sam-${b.cid.slice(0, 8)}.json`].sort());
    const reloaded = new ContactStore(backend);
    expect((await reloaded.all()).map((c) => c.cid)).toEqual([a.cid, b.cid]);
    await reloaded.remove(a.cid);
    expect(await reloaded.byDid("did:peer:4a")).toBeNull();
    expect((await backend.list(".estoc/contacts")).length).toBe(1);
  });

  it("derives safe file stems", () => {
    expect(contactFileStem("Alice")).toBe("Alice");
    expect(contactFileStem("did:peer:4zQm…abcdef")).toBe("did_peer_4zQm...abcdef");
    expect(contactFileStem("../../etc")).toBe("etc");
    expect(contactFileStem("   ")).toBe("contact");
    expect(contactFileStem("王小明")).toBe("王小明");
  });

  it("heals a rename that crashed between writing the new file and removing the old", async () => {
    const backend = new MemoryBackend();
    const store = new ContactStore(backend);
    const a = newContact("A", "did:peer:4a");
    await store.put(a);
    // the crash: the record renamed to "B" is written, A.json is still there
    await new Promise((r) => setTimeout(r, 2));
    const renamed = { ...structuredClone(a), name: "B", updatedAt: new Date().toISOString() };
    await backend.write(".estoc/contacts/B.json", new TextEncoder().encode(JSON.stringify(renamed)));
    const reloaded = new ContactStore(backend);
    expect((await reloaded.all()).map((c) => c.name)).toEqual(["B"]);
    // the older file is gone, and later puts keep following the name
    expect(await backend.list(".estoc/contacts")).toEqual(["B.json"]);
    const b = (await reloaded.byCid(a.cid)) as ContactRecord;
    b.name = "C";
    await reloaded.put(b);
    expect(await backend.list(".estoc/contacts")).toEqual(["C.json"]);
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
    const raw = dec.decode((await backend.read(".estoc/messages/0001.jsonl")) as Uint8Array);
    expect(raw.split("\n")).toHaveLength(3);
    expect(raw.endsWith("\n")).toBe(true);
    expect(await log.read()).toEqual([r1, r2]);
    expect(r1.mid < r2.mid).toBe(true);
    expect(r1.at).toBe("1970-01-01T00:00:01.000Z");
  });

  it("concatenates segments in name order and skips a truncated tail", async () => {
    const backend = new MemoryBackend();
    const log = new MessageLog(backend);
    const older = newMessageRecord({ direction: "in", msg: msg("old") });
    // a segment that arrived from elsewhere (an import) sorts first by name
    await backend.write(
      ".estoc/messages/0000-imported.jsonl",
      new TextEncoder().encode(JSON.stringify(older) + "\n")
    );
    const mine = newMessageRecord({ direction: "out", msg: msg("mine") });
    await log.append(mine);
    // a crash mid-append leaves half a line
    await backend.append(".estoc/messages/0001.jsonl", new TextEncoder().encode('{"mid":"01'));
    expect((await log.read()).map((r) => r.msg.id)).toEqual(["old", "mine"]);
  });

  it("skips a damaged line, reports it, and keeps the rest", async () => {
    const backend = new MemoryBackend();
    const good = newMessageRecord({ direction: "in", msg: msg("x") });
    await backend.write(
      ".estoc/messages/0001.jsonl",
      new TextEncoder().encode('{"nope":true}\n' + JSON.stringify(good) + "\n")
    );
    const damaged: string[] = [];
    const records = await new MessageLog(backend).read((d) => damaged.push(d.where));
    expect(records.map((r) => r.msg.id)).toEqual(["x"]);
    expect(damaged).toEqual(["0001.jsonl:1"]);
  });

  it("does not fuse a cut-short line with the next append", async () => {
    const backend = new MemoryBackend();
    const first = newMessageRecord({ direction: "out", msg: msg("1") });
    await new MessageLog(backend).append(first);
    // the crash: half a line, no terminator
    await backend.append(".estoc/messages/0001.jsonl", new TextEncoder().encode('{"mid":"01'));
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
