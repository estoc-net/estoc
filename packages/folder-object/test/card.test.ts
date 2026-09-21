import { describe, expect, it } from "vitest";
import { createSeedKeystore, addDerivedKey } from "@estoc/keystore";
import { CARD_TYP, didKeyKid, signRoot, verifyCard } from "../src/index.js";

async function signer(seedByte = 7) {
  const { doc, seedKey } = await createSeedKeystore("pw", { seed: new Uint8Array(32).fill(seedByte) });
  return (await addDerivedKey(doc, seedKey, "org/test")).identity.signer;
}

const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64bytes = (bytes: Uint8Array) => b64(String.fromCharCode(...bytes));
const ROOT = "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354";

describe("object card", () => {
  it("round-trips: sign then verify, typ and kid pinned", async () => {
    const s = await signer();
    const jws = await signRoot(s.did(), ROOT, s);
    const [h] = jws.split(".");
    expect(JSON.parse(atob(h!.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
      alg: "EdDSA",
      typ: CARD_TYP,
      kid: didKeyKid(s.did()),
    });
    expect(await verifyCard(jws)).toEqual({ did: s.did(), root: ROOT });
  });

  it("rejects a tampered payload", async () => {
    const s = await signer();
    const [h, , sig] = (await signRoot(s.did(), ROOT, s)).split(".") as [string, string, string];
    const forged = b64(JSON.stringify({ did: s.did(), root: "bafyforged" }));
    await expect(verifyCard(`${h}.${forged}.${sig}`)).rejects.toThrow(/does not verify/);
  });

  it("rejects a card whose kid names another key than the one that signed", async () => {
    const a = await signer(1);
    const b = await signer(2);
    const [, p, sig] = (await signRoot(a.did(), ROOT, a)).split(".") as [string, string, string];
    const h = b64(JSON.stringify({ alg: "EdDSA", typ: CARD_TYP, kid: didKeyKid(b.did()) }));
    await expect(verifyCard(`${h}.${p}.${sig}`)).rejects.toThrow(/does not verify/);
  });

  it("rejects a card one did signed in the name of another", async () => {
    const a = await signer(1);
    const b = await signer(2);
    const h = b64(JSON.stringify({ alg: "EdDSA", typ: CARD_TYP, kid: didKeyKid(b.did()) }));
    const p = b64(JSON.stringify({ did: a.did(), root: ROOT }));
    const sig = b64bytes(await b.sign(new TextEncoder().encode(`${h}.${p}`)));
    await expect(verifyCard(`${h}.${p}.${sig}`)).rejects.toThrow(/does not belong/);
  });

  it("rejects, of cards signed over the very header they carry, another algorithm, an extension it does not know, and an unencoded payload", async () => {
    const s = await signer();
    const card = { alg: "EdDSA", typ: CARD_TYP, kid: didKeyKid(s.did()) };
    const payload = JSON.stringify({ did: s.did(), root: ROOT });
    const signed = async (header: object, p = b64(payload)) => {
      const h = b64(JSON.stringify(header));
      return `${h}.${p}.${b64bytes(await s.sign(new TextEncoder().encode(`${h}.${p}`)))}`;
    };

    expect(await verifyCard(await signed(card))).toEqual({ did: s.did(), root: ROOT });
    await expect(verifyCard(await signed({ ...card, alg: "HS256" }))).rejects.toThrow(/"alg".*not allowed/);
    await expect(verifyCard(await signed({ ...card, alg: "none" }))).rejects.toThrow(/"alg".*not allowed/);
    await expect(verifyCard(await signed({ ...card, crit: ["exp"], exp: 1 }))).rejects.toThrow(/"exp" is not recognized/);
    await expect(verifyCard(await signed({ ...card, b64: false, crit: ["b64"] }, payload))).rejects.toThrow(/payload is base64url/);
  });

  it("rejects a card with any member beyond {did, root}", async () => {
    const s = await signer();
    const h = b64(JSON.stringify({ alg: "EdDSA", typ: CARD_TYP, kid: didKeyKid(s.did()) }));
    const p = b64(JSON.stringify({ did: s.did(), root: ROOT, iat: 1 }));
    const sig = b64bytes(await s.sign(new TextEncoder().encode(`${h}.${p}`)));
    await expect(verifyCard(`${h}.${p}.${sig}`)).rejects.toThrow(/exactly/);
  });

  it("rejects a JWS without the object-card typ", async () => {
    const s = await signer();
    const [, p, sig] = (await signRoot(s.did(), ROOT, s)).split(".") as [string, string, string];
    const h = b64(JSON.stringify({ alg: "EdDSA", kid: didKeyKid(s.did()) }));
    await expect(verifyCard(`${h}.${p}.${sig}`)).rejects.toThrow(/not an object card/);
  });

  it("rejects shapes that are not a compact JWS", async () => {
    await expect(verifyCard("nope")).rejects.toThrow(/Compact JWS/);
    await expect(verifyCard("a.b.c")).rejects.toThrow(/Header/);
  });

  it("refuses to sign as anything but a did:key", async () => {
    const s = await signer();
    await expect(signRoot("did:web:example.com", ROOT, s)).rejects.toThrow(/did:key/);
  });
});
