import { describe, expect, it } from "vitest";
import { createSeedKeystore, importSeed } from "@estoc/keystore";
import { resolveDIDCommDoc } from "@estoc/did-peer";
import { KEY_ANCHOR, KEY_INVITE_PREFIX, MemoryBackend, mediationKeyName, newContact } from "@estoc/vault";

import {
  createVault,
  invitationMessage,
  invitationUrl,
  mintPeerDid,
  openVault,
  parseInvitation,
} from "../src/index.js";

const FIXED_SEED = new Uint8Array(32).map((_, i) => i);

async function freshKeystore() {
  return createSeedKeystore("test", { seed: FIXED_SEED });
}

/**
 * The vault's format is tested in `@estoc/vault` with a minter that is
 * only a name. What the agent binds it to — did:peer:4 from a seed-derived
 * key, the routing DID as the service — is pinned here.
 */
describe("did:peer:4 over the vault", () => {
  it("pins the anchor and a mediator-facing DID for the fixed seed", async () => {
    // Any change to derivation (`estoc/v3/<purpose>/<name>`) or to the
    // did:peer:4 document shape shows up here. The mediation id is
    // random per vault, so the peer DID is pinned under a fixed name.
    const { doc, seedKey } = await freshKeystore();
    const vault = await createVault(new MemoryBackend(), { label: "x", keystore: doc, seedKey });
    expect(vault.config.identity.anchor.did).toBe("did:key:z6Mkk4RzvEvh61iNGk7gJVk9UPSrGofjLgLDrtEqzdCATJ5A");
    const me = mintPeerDid(await vault.derive(seedKey, mediationKeyName("0198b7c0-0000-7000-8000-000000000000", "me")), null);
    const resolved = await resolveDIDCommDoc(me.did);
    expect(resolved?.verificationMethod).toHaveLength(2);
    expect(resolved?.service).toEqual([]);
    expect(me.did.slice(0, 40)).toBe("did:peer:4zQmRG8Tb4SW5rtKZZUwZxTVHAmCy8N");
  });

  it("the mediator-facing DID is a did:peer:4 with no service, and its secrets are the DID's own", async () => {
    const backend = new MemoryBackend();
    const { doc, seedKey } = await freshKeystore();
    const vault = await createVault(backend, { label: "Alice", keystore: doc, seedKey, mediatorDid: "did:web:mediator.example" });
    const mediation = vault.config.mediation!;
    expect(mediation.me.did).toMatch(/^did:peer:4/);
    expect(vault.keystore.keys.map((k) => k.name)).toEqual([KEY_ANCHOR, mediation.me.key]);
    // reopened: the DID re-derives from the seed and matches its snapshot
    const again = await openVault(backend);
    const me = await again.peerIdentity(seedKey, mediation.me, null);
    expect(me.did).toBe(mediation.me.did);
    expect(me.secrets.map((s) => s.id)).toEqual([`${me.did}#key-1`, `${me.did}#key-2`]);
    // and another seed does not
    const otherSeed = await importSeed(new Uint8Array(32).map((_, i) => 31 - i));
    await expect(vault.peerIdentity(otherSeed, mediation.me, null)).rejects.toThrow(/does not derive its recorded DID/);
  });

  it("pairwise and invitation DIDs carry the routing DID as their service", async () => {
    const { doc, seedKey } = await freshKeystore();
    const routing = "did:web:mediator.example";
    const vault = await createVault(new MemoryBackend(), { label: "Alice", keystore: doc, seedKey, mediatorDid: routing });
    const contact = newContact("Bob", "did:peer:4bob");
    await vault.contacts.put(contact);
    const pairwise = await vault.mintPairwise(seedKey, contact, routing);
    expect(pairwise.did).toMatch(/^did:peer:4/);
    expect((await resolveDIDCommDoc(pairwise.did))?.service[0]?.serviceEndpoint).toMatchObject({ uri: routing });
    expect(pairwise.secrets.map((s) => s.id)).toEqual([`${pairwise.did}#key-1`, `${pairwise.did}#key-2`]);

    const { record, identity } = await vault.createInvitation(seedKey, routing, "Write to Alice");
    expect(record.key).toBe(`${KEY_INVITE_PREFIX}${record.id}`);
    expect(identity.did).toBe(record.did);
    expect((await resolveDIDCommDoc(record.did))?.service[0]?.serviceEndpoint).toMatchObject({ uri: routing });
    // the invitation message and its URL round-trip through the parser
    const message = invitationMessage(record);
    expect(message).toMatchObject({ id: record.id, from: record.did, body: { goal_code: "connect", goal: "Write to Alice", accept: ["didcomm/v2"] } });
    expect(parseInvitation(invitationUrl("https://any.host/x", message))).toEqual(message);
    // and the parser refuses what is not an invitation
    expect(() => parseInvitation("did:peer:4abc")).toThrow(/a DID, not an invitation/);
    expect(() => parseInvitation("not base64 at all!")).toThrow(/does not decode/);
    expect(() => parseInvitation("https://any.host/?x=1")).toThrow(/carries no _oob/);
    expect(() => parseInvitation(JSON.stringify({ type: "https://didcomm.org/basicmessage/2.0/message", id: "1", from: "did:x" }))).toThrow(/not an out-of-band/);
    expect(() => parseInvitation(JSON.stringify({ ...message, from: "nope" }))).toThrow(/names no DID/);
  });

  it("mintPeerDid is deterministic and service-sensitive", async () => {
    const { doc, seedKey } = await freshKeystore();
    const vault = await createVault(new MemoryBackend(), { label: "a", keystore: doc, seedKey });
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
  });
});
