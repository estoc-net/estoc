import { describe, expect, it } from "vitest";

import { resolveDIDCommDoc } from "@estoc/did-peer";
import { CONFIG_PATH, ESTOC_DIR, KEYSTORE_FILE, MemoryBackend, NotAVault } from "@estoc/event-store";
import { createSeedKeystore } from "@estoc/keystore";
import { KEY_ANCHOR, mediationKeyName } from "@estoc/vault";

import { createVault, inspectVault, mintPeerDid, openVault } from "../src/index.js";

const FIXED_SEED = new Uint8Array(32).map((_, i) => i);
const OTHER_SEED = new Uint8Array(32).map((_, i) => 31 - i);

async function freshKeystore(seed = FIXED_SEED) {
  return createSeedKeystore("test", { seed });
}

/**
 * The folder is tested in `@estoc/vault` with a minter that is only a
 * name. What the agent binds it to — did:peer:4 from a seed-derived key,
 * the routing DID as the service — is pinned here, on the v2 folder.
 */
describe("v2 identity: did:peer:4 over the folder", () => {
  it("creates, labels, and reopens as the same identity; the anchor and a mediator-facing DID are pinned for the fixed seed", async () => {
    // Any change to derivation (`estoc/v3/<purpose>/<name>`) or to the
    // did:peer:4 document shape shows up here. The mediation id is random
    // per vault, so the peer DID is pinned under a fixed name — the same
    // name v1 used, so the same DID as v1's pin.
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const made = await createVault(backend, { keystore: doc, seedKey, label: "Alice" });
    expect(made.anchor).toEqual({ key: KEY_ANCHOR, did: "did:key:z6Mkk4RzvEvh61iNGk7gJVk9UPSrGofjLgLDrtEqzdCATJ5A" });
    expect(made.fold.label()).toBe("Alice");
    expect(made.keys.keystore.keys.map((key) => key.name)).toEqual([KEY_ANCHOR]);

    const opened = await openVault(backend, seedKey);
    expect(opened.anchor).toEqual(made.anchor);
    expect(opened.vault.self).toBe(made.vault.self);
    expect(opened.fold.label()).toBe("Alice");
    expect(opened.fold.device(opened.vault.self)?.mintedAt).not.toBeNull();

    const me = await opened.keys.identity(mediationKeyName("0198b7c0-0000-7000-8000-000000000000"), null);
    expect(me.did.slice(0, 40)).toBe("did:peer:4zQmRG8Tb4SW5rtKZZUwZxTVHAmCy8N");
    expect(me.secrets.map((s) => s.id)).toEqual([`${me.did}#key-1`, `${me.did}#key-2`]);
    const resolved = await resolveDIDCommDoc(me.did);
    expect(resolved?.verificationMethod).toHaveLength(2);
    expect(resolved?.service).toEqual([]);
  });

  it("refuses the wrong seed on open, and a used keystore on create", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const made = await createVault(backend, { keystore: doc, seedKey, label: "Alice" });
    const other = await freshKeystore(OTHER_SEED);
    await expect(openVault(backend, other.seedKey)).rejects.toThrow(/wrong seed/);
    await expect(createVault(new MemoryBackend(), { keystore: made.keys.keystore, seedKey, label: "again" })).rejects.toThrow(/no keys/);
  });

  it("a DID with a service carries the routing DID; the same key and service give the same DID", async () => {
    const { doc, seedKey } = await freshKeystore();
    const made = await createVault(new MemoryBackend(), { keystore: doc, seedKey, label: "Alice" });
    const routing = "did:peer:2.Ez6routing";
    const a = await made.keys.identity("did/x", routing);
    const b = await made.keys.identity("did/x", routing);
    const c = await made.keys.identity("did/x", null);
    expect(a.did).toBe(b.did);
    expect(a.did).not.toBe(c.did);
    const doc2 = await resolveDIDCommDoc(a.did);
    expect(doc2?.service[0]?.serviceEndpoint).toEqual({ uri: routing, accept: ["didcomm/v2"], routingKeys: [] });
    expect(doc2?.keyAgreement).toEqual([`${a.did}#key-2`]);
    // `identity` derives; it does not mint: the cache lists the anchor alone
    expect(made.keys.keystore.keys.map((key) => key.name)).toEqual([KEY_ANCHOR]);
    expect(mintPeerDid).toBeTypeOf("function");
  });

  it("inspects without the seed: the folder and the sealed keystore; a v1 folder, or none, is not a vault", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const made = await createVault(backend, { keystore: doc, seedKey, label: "Alice" });
    const inspected = await inspectVault(backend);
    expect(inspected.vault.self).toBe(made.vault.self);
    expect(inspected.keystore).toEqual(made.keys.keystore); // the document as create left it: sealed seed, the anchor cached

    await expect(inspectVault(new MemoryBackend())).rejects.toThrow(NotAVault);

    // a version-1 folder, as the v1 agent laid one down: config.json says
    // version 1 and carries the label and mediation, the keystore is a v3
    // document like ours — refused at the config, the keystore never read
    const other = await freshKeystore(OTHER_SEED);
    const v1 = new MemoryBackend();
    const encoder = new TextEncoder();
    await v1.write(
      CONFIG_PATH,
      encoder.encode(JSON.stringify({ format: "estoc", version: 1, label: "Alice", identity: { anchor: { key: KEY_ANCHOR, did: "did:key:z6Mk" } }, mediation: null }))
    );
    await v1.write(`${ESTOC_DIR}/${KEYSTORE_FILE}`, encoder.encode(JSON.stringify(other.doc)));
    await expect(inspectVault(v1)).rejects.toThrow(NotAVault);
    await expect(openVault(v1, other.seedKey)).rejects.toThrow(NotAVault);
  });
});
