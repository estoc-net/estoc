import { describe, expect, it } from "vitest";
import { createCard, verifyCard } from "../src/index.js";
import type { CardSigner, RootCard } from "../src/index.js";

/** A WebCrypto-backed test signer — same contract a keystore Signer meets. */
async function testSigner(): Promise<{ signer: CardSigner; publicKey: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    signer: {
      sign: async (data) =>
        new Uint8Array(
          await crypto.subtle.sign("Ed25519", pair.privateKey, data as Uint8Array<ArrayBuffer>),
        ),
    },
    publicKey: raw,
  };
}

const card: RootCard = {
  did: "did:peer:2:Ez6LS...",
  id: "0198c2f0-0000-7000-8000-000000000000",
  expires: "2026-09-18T00:00:00Z",
  root: "baguqeeraexample",
};
const kid = `${card.did}#key-1`;

describe("root card", () => {
  it("round-trips: create then verify", async () => {
    const { signer, publicKey } = await testSigner();
    const jws = await createCard(card, signer, kid);
    expect(jws.split(".")).toHaveLength(3);
    const verified = await verifyCard(jws, () => publicKey);
    expect(verified.card).toEqual(card);
    expect(verified.kid).toBe(kid);
  });

  it("rejects a tampered payload", async () => {
    const { signer, publicKey } = await testSigner();
    const jws = await createCard(card, signer, kid);
    const [h, , s] = jws.split(".") as [string, string, string];
    const forged = btoa(JSON.stringify({ ...card, root: "bafyforged" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(verifyCard(`${h}.${forged}.${s}`, () => publicKey)).rejects.toThrow(
      /does not verify/,
    );
  });

  it("rejects the wrong key", async () => {
    const { signer } = await testSigner();
    const { publicKey: otherKey } = await testSigner();
    const jws = await createCard(card, signer, kid);
    await expect(verifyCard(jws, () => otherKey)).rejects.toThrow(/does not verify/);
  });

  it("rejects an unknown kid", async () => {
    const { signer } = await testSigner();
    const jws = await createCard(card, signer, kid);
    await expect(verifyCard(jws, () => null)).rejects.toThrow(/unknown kid/);
  });

  it("round-trips a takedown card (root: null)", async () => {
    const { signer, publicKey } = await testSigner();
    const takedown: RootCard = { did: card.did, id: card.id, expires: card.expires, root: null };
    const jws = await createCard(takedown, signer, kid);
    const verified = await verifyCard(jws, () => publicKey);
    expect(verified.card).toEqual(takedown);
    expect(verified.card.root).toBeNull();
  });

  it("rejects a card missing root — null is the only takedown encoding", async () => {
    const { signer, publicKey } = await testSigner();
    const { root: _root, ...fieldless } = card;
    const jws = await createCard(fieldless as RootCard, signer, kid);
    await expect(verifyCard(jws, () => publicKey)).rejects.toThrow(/malformed root card/);
  });

  it("newer-card comparison is a string comparison on id", () => {
    const older = "0198c2f0-0000-7000-8000-000000000000";
    const newer = "0198c2f0-0001-7000-8000-000000000000";
    expect(newer > older).toBe(true);
  });

  it("does not enforce expiry — that is acceptance policy", async () => {
    const { signer, publicKey } = await testSigner();
    const stale = { ...card, expires: "2000-01-01T00:00:00Z" };
    const jws = await createCard(stale, signer, kid);
    const verified = await verifyCard(jws, () => publicKey);
    expect(verified.card.expires).toBe("2000-01-01T00:00:00Z");
  });
});
