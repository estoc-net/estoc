import { describe, expect, it } from "vitest";

import { FromPrior as UpstreamFromPrior, Message as UpstreamMessage } from "didcomm-node";
import { FlattenedEncrypt, importJWK } from "jose";

import { resolveDIDCommDoc, toDIDCommDIDDoc, type DIDDoc, type Secret } from "@estoc/did-peer";
import { scanVault, type Did, type DidId, type RouteId } from "@estoc/vault/v3";

import { EnvelopeRefused, secretsResolverFor, unpack, type DidcommApi, type IMessage, type SecretsResolver } from "../../src/protocol/didcomm.js";
import { Keyring, configureRoute, createDid } from "../../src/v3/index.js";
import { didcomm, freshVault, newMediator, webIdentity, type Fresh, type WebIdentity } from "./helpers.js";

const BOB = "did:web:bob.example";
const MALLORY = "did:web:mallory.example";
const CHARLIE = "did:web:charlie.example";
const ROUTE = "019b0000-0000-7000-8000-00000000000a" as RouteId;
const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;

/** Alice: a vault with one communication DID on a direct route, and her keys in hand. */
async function alice(): Promise<Fresh & { longFormDid: Did; ring: Keyring; secrets: SecretsResolver }> {
  const fresh = await freshVault();
  await configureRoute(fresh.runtime, fresh.keys, { kind: "direct", endpoint: "https://alice.example/didcomm" }, ROUTE);
  const { minted } = await createDid(fresh.runtime, fresh.keys, ROUTE, DID);
  const ring = await Keyring.load(fresh.keys, await scanVault(fresh.runtime.vault, fresh.keys));
  return { ...fresh, longFormDid: minted.longFormDid, ring, secrets: secretsResolverFor(ring.secrets()) };
}

/** A resolver that knows Peer DIDs and the `did:web` identities given, and records every DID asked of it. */
function resolverOf(...known: WebIdentity[]): { asked: string[]; resolve: (did: string) => Promise<DIDDoc | null> } {
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

/** `raw`, whatever it is, in an anonymous envelope to the key-agreement key `kid` with public JWK `jwk`: what no library packer would put on a wire. */
async function anonymously(raw: string, kid: string, jwk: JsonWebKey): Promise<string> {
  const apv = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(kid)));
  const jwe = await new FlattenedEncrypt(new TextEncoder().encode(raw))
    .setProtectedHeader({ typ: "application/didcomm-encrypted+json", alg: "ECDH-ES+A256KW", enc: "A256GCM" })
    .setUnprotectedHeader({ kid })
    .setKeyManagementParameters({ apv })
    .encrypt(await importJWK(jwk, "ECDH-ES+A256KW"));
  const { header, encrypted_key, ...rest } = jwe;
  return JSON.stringify({ ...rest, recipients: [{ header, encrypted_key }] });
}

/** Alice's key-agreement key as a sender would seal to it. */
function agreementKeyOf(secrets: Secret[]): { kid: string; jwk: JsonWebKey } {
  const secret = secrets.find((s) => s.privateKeyJwk?.crv === "X25519") as Secret;
  const { kty, crv, x } = secret.privateKeyJwk as { kty: string; crv: string; x: string };
  return { kid: secret.id, jwk: { kty, crv, x } };
}

describe("unpack", () => {
  it("opens a message whose rotation proof names an issuer it cannot resolve: the sealer is the sender, the proof is the string off the wire", async () => {
    const a = await alice();
    const bob = await rotatedBob();
    const [packed] = await bob.seal(a.longFormDid, plain(bob.successor.did, a.longFormDid, { from_prior: bob.proof }));
    const resolver = resolverOf();
    const opened = await unpack(didcomm, packed, resolver, a.secrets);
    expect(opened.plaintext.body).toEqual({ content: "hi" });
    expect(opened.sender).toEqual({ did: bob.successor.did, kid: `${bob.successor.did}#key-2` });
    expect(opened.fromPrior).toBe(bob.proof);
    expect(opened.metadata.authenticated).toBe(true);
    expect(resolver.asked).not.toContain(BOB);
    await expect(UpstreamMessage.unpack(packed, resolver, a.secrets, {})).rejects.toThrow(/from_prior/);
    await a.runtime.close();
  });

  it("opens a message whose proof does not verify against the issuer's document as the recipient has it, keeping the proof as it came", async () => {
    const a = await alice();
    const bob = await rotatedBob();
    const impostor = await webIdentity(BOB, 78);
    const [packed] = await bob.seal(a.longFormDid, plain(bob.successor.did, a.longFormDid, { from_prior: bob.proof }));
    const opened = await unpack(didcomm, packed, resolverOf(impostor), a.secrets);
    expect(opened.fromPrior).toBe(bob.proof);
    expect(opened.sender?.did).toBe(bob.successor.did);
    await expect(UpstreamMessage.unpack(packed, resolverOf(impostor), a.secrets, {})).rejects.toThrow(/from_prior signature/);
    await a.runtime.close();
  });

  it("carries null for a message without a proof", async () => {
    const a = await alice();
    const bob = await rotatedBob();
    const [packed] = await bob.seal(a.longFormDid, plain(bob.successor.did, a.longFormDid));
    const opened = await unpack(didcomm, packed, resolverOf(), a.secrets);
    expect(opened.fromPrior).toBeNull();
    expect(opened.sender?.did).toBe(bob.successor.did);
    await a.runtime.close();
  });

  it("takes the proof off the wire as the binding parses it: a string as is, null as absent, anything else malformed", async () => {
    const a = await alice();
    const key = agreementKeyOf(a.ring.secrets());
    for (const proof of ["not a jwt", ""]) {
      const opened = await unpack(didcomm, await anonymously(JSON.stringify(plain(null, a.longFormDid, { from_prior: proof })), key.kid, key.jwk), resolverOf(), a.secrets);
      expect(opened.fromPrior).toBe(proof);
    }
    const nulled = await unpack(didcomm, await anonymously(JSON.stringify({ ...plain(null, a.longFormDid), from_prior: null }), key.kid, key.jwk), resolverOf(), a.secrets);
    expect(nulled.fromPrior).toBeNull();
    expect(Object.hasOwn(nulled.plaintext, "from_prior")).toBe(false);
    for (const proof of [5, {}, []]) {
      const opening = unpack(didcomm, await anonymously(JSON.stringify({ ...plain(null, a.longFormDid), from_prior: proof }), key.kid, key.jwk), resolverOf(), a.secrets);
      await expect(opening).rejects.toThrow(/Malformed/);
      await expect(opening).rejects.not.toThrow(EnvelopeRefused);
    }
    await a.runtime.close();
  });

  it("names no sender for an anonymous envelope, whatever the plaintext claims and whoever signed it", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB, 77);
    const side = resolverOf(bob);
    const [anonymous] = await new didcomm.Message(plain(BOB, a.longFormDid)).pack_encrypted(a.longFormDid, null, null, side, secretsResolverFor(bob.secrets), { forward: false });
    const opened = await unpack(didcomm, anonymous, resolverOf(bob), a.secrets);
    expect(opened.sender).toBeNull();
    expect(opened.plaintext.from).toBe(BOB);
    expect(opened.metadata.authenticated).toBe(false);
    const [signed] = await new didcomm.Message(plain(BOB, a.longFormDid)).pack_encrypted(a.longFormDid, null, `${BOB}#auth`, side, secretsResolverFor(bob.secrets), { forward: false });
    const openedSigned = await unpack(didcomm, signed, resolverOf(bob), a.secrets);
    expect(openedSigned.sender).toBeNull();
    expect(openedSigned.metadata.non_repudiation).toBe(true);
    await a.runtime.close();
  });

  it("requires the plaintext's from to name the sealer, and a signature inside to be the sealer's", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB, 77);
    const mallory = await webIdentity(MALLORY, 79);
    const bobs = secretsResolverFor([...bob.secrets, ...mallory.secrets]);
    const seal = (message: IMessage, from: string, signBy: string | null, side = resolverOf(bob, mallory)) => new didcomm.Message(message).pack_encrypted(a.longFormDid, from, signBy, side, bobs, { forward: false });
    const [honest] = await seal(plain(BOB, a.longFormDid), BOB, `${BOB}#auth`);
    expect((await unpack(didcomm, honest, resolverOf(bob), a.secrets)).sender?.did).toBe(BOB);
    const asMallory = { asked: [], resolve: async (did: string) => (did === MALLORY ? (toDIDCommDIDDoc(bob.document) as DIDDoc) : resolverOf(bob).resolve(did)) };
    const [claimed] = await seal(plain(MALLORY, a.longFormDid), MALLORY, null, asMallory);
    await expect(unpack(didcomm, claimed, resolverOf(bob), a.secrets)).rejects.toThrow(/does not name the sealer/);
    const [unnamed] = await seal(plain(null, a.longFormDid), BOB, null);
    await expect(unpack(didcomm, unnamed, resolverOf(bob), a.secrets)).rejects.toThrow(/from is missing/);
    const [forged] = await seal(plain(BOB, a.longFormDid), BOB, `${MALLORY}#auth`);
    await expect(unpack(didcomm, forged, resolverOf(bob, mallory), a.secrets)).rejects.toThrow(/signed by another/);
    await a.runtime.close();
  });

  it("refuses an authenticated layer inside an anonymous one, to us or to another key of ours: the binding reports only the outer recipients", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB, 77);
    const charlie = await webIdentity(CHARLIE, 80);
    const side = resolverOf(bob);
    const [protectedSender] = await new didcomm.Message(plain(BOB, a.longFormDid)).pack_encrypted(a.longFormDid, BOB, null, side, secretsResolverFor(bob.secrets), { forward: false, protect_sender: true });
    await expect(unpack(didcomm, protectedSender, resolverOf(bob), a.secrets)).rejects.toThrow(EnvelopeRefused);
    const [toAlice] = await new didcomm.Message(plain(BOB, a.longFormDid)).pack_encrypted(a.longFormDid, BOB, null, side, secretsResolverFor(bob.secrets), { forward: false });
    const rewrapped = await anonymously(toAlice, `${CHARLIE}#agree`, (charlie.document.verificationMethod as unknown as { publicKeyJwk: JsonWebKey }[])[1]!.publicKeyJwk);
    const both = secretsResolverFor([...a.ring.secrets(), ...charlie.secrets]);
    const [, metadata] = await didcomm.Message.unpack(rewrapped, resolverOf(bob), both, { verify_from_prior: false });
    expect(metadata.encrypted_to_kids).toEqual([`${CHARLIE}#agree`]);
    await expect(unpack(didcomm, rewrapped, resolverOf(bob), both)).rejects.toThrow(EnvelopeRefused);
    await a.runtime.close();
  });

  it("rejects a tampered envelope and a sealer the resolved document does not authorize", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB, 77);
    const impostor = await webIdentity(BOB, 78);
    const [packed] = await new didcomm.Message(plain(BOB, a.longFormDid)).pack_encrypted(a.longFormDid, BOB, null, resolverOf(bob), secretsResolverFor(bob.secrets), { forward: false });
    expect((await unpack(didcomm, packed, resolverOf(bob), a.secrets)).sender?.did).toBe(BOB);
    const envelope = JSON.parse(packed) as { tag: string };
    envelope.tag = envelope.tag.slice(0, -2) + (envelope.tag.endsWith("AA") ? "BB" : "AA");
    await expect(unpack(didcomm, JSON.stringify(envelope), resolverOf(bob), a.secrets)).rejects.toThrow();
    await expect(unpack(didcomm, packed, resolverOf(impostor), a.secrets)).rejects.toThrow();
    await expect(unpack(didcomm, packed, resolverOf(), a.secrets)).rejects.toThrow();
    await a.runtime.close();
  });

  it("refuses what is not encrypted: a signed plaintext is anyone's to forward", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB, 77);
    const [signed] = await new didcomm.Message(plain(BOB, a.longFormDid)).pack_signed(`${BOB}#auth`, resolverOf(bob), secretsResolverFor(bob.secrets));
    await expect(unpack(didcomm, signed, resolverOf(bob), a.secrets)).rejects.toThrow(EnvelopeRefused);
    await a.runtime.close();
  });

  it("refuses a binding that verified the proof itself: only the Estoc builds leave it to the vault", async () => {
    const a = await alice();
    const bob = await rotatedBob();
    const [packed] = await bob.seal(a.longFormDid, plain(bob.successor.did, a.longFormDid, { from_prior: bob.proof }));
    const upstream = { Message: UpstreamMessage, FromPrior: UpstreamFromPrior } as unknown as DidcommApi;
    await expect(unpack(upstream, packed, resolverOf(bob.predecessor), a.secrets)).rejects.toThrow(/not a build/);
    await a.runtime.close();
  });
});
