import { describe, expect, it } from "vitest";

import { FromPrior as UpstreamFromPrior, Message as UpstreamMessage } from "didcomm-node";

import { resolveDIDCommDoc, toDIDCommDIDDoc, type DIDDoc } from "@estoc/did-peer";
import { scanVault, type Did, type DidId, type RouteId } from "@estoc/vault/v3";

import { EnvelopeRefused, secretsResolverFor, unpack, type DidcommApi, type IMessage, type UnpackMetadata } from "../../src/protocol/didcomm.js";
import { Keyring, configureRoute, createDid } from "../../src/v3/index.js";
import { didcomm, freshVault, newMediator, webIdentity, type Fresh, type WebIdentity } from "./helpers.js";

const BOB = "did:web:bob.example";
const ROUTE = "019b0000-0000-7000-8000-00000000000a" as RouteId;
const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;

/** Alice: a vault with one communication DID on a direct route, and her keys in hand. */
async function alice(): Promise<Fresh & { longFormDid: Did; ring: Keyring }> {
  const fresh = await freshVault();
  await configureRoute(fresh.runtime, fresh.keys, { kind: "direct", endpoint: "https://alice.example/didcomm" }, ROUTE);
  const { minted } = await createDid(fresh.runtime, fresh.keys, ROUTE, DID);
  const ring = await Keyring.load(fresh.keys, await scanVault(fresh.runtime.vault, fresh.keys));
  return { ...fresh, longFormDid: minted.longFormDid, ring };
}

/** A resolver that knows Peer DIDs and the `did:web` identities given, and records every DID asked of it. */
function resolverOf(...known: WebIdentity[]) {
  const asked: string[] = [];
  const web = new Map(known.map((identity) => [identity.did, toDIDCommDIDDoc(identity.document) as DIDDoc]));
  return {
    asked,
    resolve: async (did: string): Promise<DIDDoc | null> => {
      asked.push(did);
      return web.get(did) ?? resolveDIDCommDoc(did);
    },
  };
}

const plain = (from: string | null, to: string, extra: Partial<IMessage> = {}): IMessage =>
  ({ id: "m1", typ: "application/didcomm-plain+json", type: "https://didcomm.org/basicmessage/2.0/message", ...(from === null ? {} : { from }), to: [to], body: { content: "hi" }, ...extra }) as IMessage;

/** Bob, who left `BOB` for a Peer DID, writing to Alice with the proof of it; the sender side resolves both. */
async function rotatedBob() {
  const predecessor = await webIdentity(BOB, 77);
  const successor = await newMediator(203);
  const side = resolverOf(predecessor);
  const [proof] = await new didcomm.FromPrior({ iss: BOB, sub: successor.did }).pack(`${BOB}#auth`, side, secretsResolverFor(predecessor.secrets));
  const seal = (to: string, message: IMessage) => new didcomm.Message(message).pack_encrypted(to, successor.did, null, side, secretsResolverFor(successor.secrets), { forward: false });
  return { predecessor, successor, proof, seal };
}

describe("unpack", () => {
  it("opens a message whose rotation proof names an issuer it cannot resolve: the sealer is the sender, the proof is the string off the wire", async () => {
    const a = await alice();
    const bob = await rotatedBob();
    const [packed] = await bob.seal(a.longFormDid, plain(bob.successor.did, a.longFormDid, { from_prior: bob.proof }));
    const resolver = resolverOf();
    const secrets = secretsResolverFor(a.ring.secrets());
    const opened = await unpack(didcomm, packed, resolver, secrets);
    expect(opened.plaintext.body).toEqual({ content: "hi" });
    expect(opened.sender).toEqual({ did: bob.successor.did, kid: `${bob.successor.did}#key-2` });
    expect(opened.fromPrior).toBe(bob.proof);
    expect(opened.metadata.authenticated).toBe(true);
    expect(resolver.asked).not.toContain(BOB);
    await expect(UpstreamMessage.unpack(packed, resolver, secrets, {})).rejects.toThrow(/from_prior/);
    await a.runtime.close();
  });

  it("opens a message whose proof does not verify against the issuer's document as the recipient has it, keeping the proof as it came", async () => {
    const a = await alice();
    const bob = await rotatedBob();
    const impostor = await webIdentity(BOB, 78);
    const secrets = secretsResolverFor(a.ring.secrets());
    const [packed] = await bob.seal(a.longFormDid, plain(bob.successor.did, a.longFormDid, { from_prior: bob.proof }));
    const opened = await unpack(didcomm, packed, resolverOf(impostor), secrets);
    expect(opened.fromPrior).toBe(bob.proof);
    expect(opened.sender?.did).toBe(bob.successor.did);
    await expect(UpstreamMessage.unpack(packed, resolverOf(impostor), secrets, {})).rejects.toThrow(/from_prior signature/);
    await a.runtime.close();
  });

  it("passes a proof through as the string it is, whether a JWT or not; one that is not a string is a malformed wire", async () => {
    for (const proof of ["not a jwt", ""]) {
      const opened = await unpack(stub(plain(BOB, "did:example:alice", { from_prior: proof }), { encrypted: true, authenticated: true }), "packed", resolverOf(), secretsResolverFor([]));
      expect(opened.fromPrior).toBe(proof);
    }
    const numeric = stub(plain(BOB, "did:example:alice", { from_prior: 5 as unknown as string }), { encrypted: true, authenticated: true });
    await expect(unpack(numeric, "packed", resolverOf(), secretsResolverFor([]))).rejects.toThrow(EnvelopeRefused);
  });

  it("carries null for a message without a proof", async () => {
    const a = await alice();
    const bob = await rotatedBob();
    const [packed] = await bob.seal(a.longFormDid, plain(bob.successor.did, a.longFormDid));
    const opened = await unpack(didcomm, packed, resolverOf(), secretsResolverFor(a.ring.secrets()));
    expect(opened.fromPrior).toBeNull();
    expect(opened.sender?.did).toBe(bob.successor.did);
    await a.runtime.close();
  });

  it("names no sender for an anonymous envelope, whatever the plaintext claims and whoever signed it", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB, 77);
    const side = resolverOf(bob);
    const secrets = secretsResolverFor(a.ring.secrets());
    const [anonymous] = await new didcomm.Message(plain(BOB, a.longFormDid)).pack_encrypted(a.longFormDid, null, null, side, secretsResolverFor(bob.secrets), { forward: false });
    const opened = await unpack(didcomm, anonymous, resolverOf(bob), secrets);
    expect(opened.sender).toBeNull();
    expect(opened.plaintext.from).toBe(BOB);
    expect(opened.metadata.authenticated).toBe(false);
    const [signed] = await new didcomm.Message(plain(BOB, a.longFormDid)).pack_encrypted(a.longFormDid, null, `${BOB}#auth`, side, secretsResolverFor(bob.secrets), { forward: false });
    const openedSigned = await unpack(didcomm, signed, resolverOf(bob), secrets);
    expect(openedSigned.sender).toBeNull();
    expect(openedSigned.metadata.non_repudiation).toBe(true);
    await a.runtime.close();
  });

  it("rejects a tampered envelope and a sealer the resolved document does not authorize", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB, 77);
    const impostor = await webIdentity(BOB, 78);
    const secrets = secretsResolverFor(a.ring.secrets());
    const [packed] = await new didcomm.Message(plain(BOB, a.longFormDid)).pack_encrypted(a.longFormDid, BOB, null, resolverOf(bob), secretsResolverFor(bob.secrets), { forward: false });
    expect((await unpack(didcomm, packed, resolverOf(bob), secrets)).sender?.did).toBe(BOB);
    const envelope = JSON.parse(packed) as { tag: string };
    envelope.tag = envelope.tag.slice(0, -2) + (envelope.tag.endsWith("AA") ? "BB" : "AA");
    await expect(unpack(didcomm, JSON.stringify(envelope), resolverOf(bob), secrets)).rejects.toThrow();
    await expect(unpack(didcomm, packed, resolverOf(impostor), secrets)).rejects.toThrow();
    await expect(unpack(didcomm, packed, resolverOf(), secrets)).rejects.toThrow();
    await a.runtime.close();
  });

  it("refuses what is not encrypted: a signed plaintext is anyone's to forward", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB, 77);
    const [signed] = await new didcomm.Message(plain(BOB, a.longFormDid)).pack_signed(`${BOB}#auth`, resolverOf(bob), secretsResolverFor(bob.secrets));
    await expect(unpack(didcomm, signed, resolverOf(bob), secretsResolverFor(a.ring.secrets()))).rejects.toThrow(EnvelopeRefused);
    await a.runtime.close();
  });

  it("refuses a binding that verified the proof itself: only the Estoc builds leave it to the vault", async () => {
    const a = await alice();
    const bob = await rotatedBob();
    const [packed] = await bob.seal(a.longFormDid, plain(bob.successor.did, a.longFormDid, { from_prior: bob.proof }));
    const upstream = { Message: UpstreamMessage, FromPrior: UpstreamFromPrior } as unknown as DidcommApi;
    await expect(unpack(upstream, packed, resolverOf(bob.predecessor), secretsResolverFor(a.ring.secrets()))).rejects.toThrow(/not a build/);
    await a.runtime.close();
  });
});

/** A binding whose unpack hands back `plaintext` under `metadata`, whatever it is given: what the library's own packer would never put on a wire. */
function stub(plaintext: IMessage, metadata: Partial<UnpackMetadata>): DidcommApi {
  class Message {
    as_value(): IMessage {
      return plaintext;
    }
    free(): void {}
    static async unpack(): Promise<[Message, UnpackMetadata]> {
      return [new Message(), metadata as UnpackMetadata];
    }
  }
  return { Message, FromPrior: class {} } as unknown as DidcommApi;
}
