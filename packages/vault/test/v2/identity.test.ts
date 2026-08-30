import { describe, expect, it } from "vitest";

import { MemoryBackend, MemoryVault, NotAVault } from "@estoc/event-store";
import { addDerivedKey, createSeedKeystore, parseSeedKeystore, serializeKeystore, type DerivedIdentity } from "@estoc/keystore";

import { KEY_ANCHOR, Keys, VaultFold, createFolderVault, openFolderVault, type MintDid } from "../../src/v2/index.js";

const FIXED_SEED = new Uint8Array(32).map((_, i) => i);
const OTHER_SEED = new Uint8Array(32).map((_, i) => 31 - i);
const dec = new TextDecoder();

/** A minter that is only a name: what a DID is minted as is not this layer's question. */
const mint: MintDid<{ did: string; service: string | null; identity: DerivedIdentity }> = (identity, service) => ({
  did: `did:test:${identity.did.slice(8)}${service === null ? "" : `;via=${service}`}`,
  service,
  identity,
});

async function freshKeystore(seed = FIXED_SEED) {
  return createSeedKeystore("test", { seed });
}

describe("v2 identity: the folder", () => {
  it("creates keystore then config, and reopens as the same identity", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const made = await createFolderVault(backend, doc, seedKey, { mint });
    expect(made.anchor.key).toBe(KEY_ANCHOR);
    expect(made.anchor.did.startsWith("did:key:z")).toBe(true);
    const config = JSON.parse(dec.decode((await backend.read(".estoc/config.json")) as Uint8Array)) as { identity: { anchor: { key: string; did: string } } };
    expect(config.identity.anchor).toEqual(made.anchor);
    const stored = parseSeedKeystore(dec.decode((await made.vault.files.read("keystore.json")) as Uint8Array));
    expect(stored.keys.map((key) => key.name)).toEqual([KEY_ANCHOR]);
    expect(made.fold.device(made.vault.self)?.mintedAt).not.toBeNull();

    const opened = await openFolderVault(backend, seedKey, { mint });
    expect(opened.anchor).toEqual(made.anchor);
    expect(opened.vault.self).toBe(made.vault.self);
  });

  it("refuses a fresh keystore that already has keys, and a wrong seed on open", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    await createFolderVault(backend, doc, seedKey, { mint });
    const other = await freshKeystore(OTHER_SEED);
    await expect(openFolderVault(backend, other.seedKey, { mint })).rejects.toThrow(/wrong seed/);
    await expect(createFolderVault(new MemoryBackend(), (await openFolderVault(backend, seedKey, { mint })).keys.keystore, seedKey, { mint })).rejects.toThrow(/no keys/);
  });

  it("refuses a backend that already holds a vault, its keystore untouched", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    await createFolderVault(backend, doc, seedKey, { mint });
    const other = await freshKeystore(OTHER_SEED);
    await expect(createFolderVault(backend, other.doc, other.seedKey, { mint })).rejects.toThrow(/exists already/);
    const opened = await openFolderVault(backend, seedKey, { mint }); // the first seed still opens what it made
    expect(opened.anchor.did.startsWith("did:key:z")).toBe(true);
  });

  it("catches a raced create before returning: the keystore read back is not ours", async () => {
    const other = await freshKeystore(OTHER_SEED);
    const { doc: otherDoc } = await addDerivedKey(other.doc, other.seedKey, KEY_ANCHOR);
    const foreign = new TextEncoder().encode(serializeKeystore(otherDoc));
    const raced = new (class extends MemoryBackend {
      override async write(path: string, data: Uint8Array): Promise<void> {
        await super.write(path, data);
        if (path.endsWith("config.json")) {
          await super.write(".estoc/keystore.json", foreign); // the other create's write lands mid-flight
        }
      }
    })();
    const { doc, seedKey } = await freshKeystore();
    await expect(createFolderVault(raced, doc, seedKey, { mint })).rejects.toThrow(/raced/);
  });

  it("catches a raced create at the next open: the keystore is another seed's", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    await createFolderVault(backend, doc, seedKey, { mint });
    // the loser's keystore lands after the winner returned
    const other = await freshKeystore(OTHER_SEED);
    const { doc: otherDoc } = await addDerivedKey(other.doc, other.seedKey, KEY_ANCHOR);
    await backend.write(".estoc/keystore.json", new TextEncoder().encode(serializeKeystore(otherDoc)));
    await expect(openFolderVault(backend, seedKey, { mint })).rejects.toThrow(/another seed's anchor/);
  });

  it("mints DIDs and mediations: the event first, the cache after, the name derivable alone", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const { vault, keys, fold } = await createFolderVault(backend, doc, seedKey, { mint });

    const mediation = await keys.createMediation(fold, "did:web:mediator.example");
    expect(mediation.key).toBe(`mediation/${mediation.id}/me`);
    expect(mediation.identity.service).toBeNull();
    expect(fold.device(vault.self)?.mediation?.id).toBe(mediation.id);

    const minted = await keys.mintDid(fold, { id: mediation.id, routingDid: "did:peer:2route" });
    expect(minted.key.startsWith("did/")).toBe(true);
    expect(minted.event.data).toEqual({ key: minted.key, did: minted.identity.did, routingDid: "did:peer:2route", mediation: mediation.id });
    expect(fold.myKey(minted.key)?.minted?.did).toBe(minted.identity.did);

    const stored = parseSeedKeystore(dec.decode((await vault.files.read("keystore.json")) as Uint8Array));
    expect(stored.keys.map((key) => key.name).sort()).toEqual([KEY_ANCHOR, minted.key, mediation.key].sort());

    // the same name derives the same DID, cache or none
    expect((await keys.identity(minted.key, "did:peer:2route")).did).toBe(minted.identity.did);
  });

  it("rebuilds the key cache from the log", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const { vault, keys, fold } = await createFolderVault(backend, doc, seedKey, { mint });
    const mediation = await keys.createMediation(fold, "did:web:mediator.example");
    const minted = await keys.mintDid(fold, { id: mediation.id, routingDid: "did:peer:2route" });

    // the cache is lost: a fresh document around the same seed
    const fresh = await freshKeystore();
    await vault.files.write("keystore.json", new TextEncoder().encode(serializeKeystore(fresh.doc)));
    const reopened = await Keys.open(vault, seedKey, { mint });
    const added = await reopened.rebuildCache(await VaultFold.of(vault.events));
    expect(added.sort()).toEqual([KEY_ANCHOR, minted.key, mediation.key].sort());
    const stored = parseSeedKeystore(dec.decode((await vault.files.read("keystore.json")) as Uint8Array));
    expect(stored.keys.map((key) => key.name).sort()).toEqual([KEY_ANCHOR, minted.key, mediation.key].sort());
    // and again: nothing missing
    expect(await reopened.rebuildCache(await VaultFold.of(vault.events))).toEqual([]);
  });

  it("runs over memory stores too: init writes the keystore, open refuses its absence", async () => {
    const vault = new MemoryVault();
    const { doc, seedKey } = await freshKeystore();
    await expect(Keys.open(vault, seedKey, { mint })).rejects.toThrow(NotAVault);
    const keys = await Keys.init(vault, doc, seedKey, { mint });
    await keys.verifyAnchor((await Keys.anchorOf(seedKey)).did);
    const stored = parseSeedKeystore(dec.decode((await vault.files.read("keystore.json")) as Uint8Array));
    expect(stored.keys.map((key) => key.name)).toEqual([KEY_ANCHOR]);
    await expect(keys.verifyAnchor("did:key:z6MkSomebodyElse")).rejects.toThrow(/wrong seed/);
  });
});
