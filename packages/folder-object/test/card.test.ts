import { describe, expect, it } from "vitest";
import { createSeedKeystore, addDerivedKey } from "@estoc/keystore";
import { CARD_TYP, didKeyKid, signRoot, verifyCard } from "../src/index.js";

async function signer(seedByte = 7) {
  const { doc, seedKey } = await createSeedKeystore("pw", { seed: new Uint8Array(32).fill(seedByte) });
  return (await addDerivedKey(doc, seedKey, "org/test")).identity.signer;
}

const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

  it("rejects a card whose kid is not the payload did's", async () => {
    const a = await signer(1);
    const b = await signer(2);
    const [, p, sig] = (await signRoot(a.did(), ROOT, a)).split(".") as [string, string, string];
    const h = b64(JSON.stringify({ alg: "EdDSA", typ: CARD_TYP, kid: didKeyKid(b.did()) }));
    await expect(verifyCard(`${h}.${p}.${sig}`)).rejects.toThrow(/does not belong/);
  });

  it("rejects a card with any member beyond {did, root}", async () => {
    const s = await signer();
    const h = b64(JSON.stringify({ alg: "EdDSA", typ: CARD_TYP, kid: didKeyKid(s.did()) }));
    const p = b64(JSON.stringify({ did: s.did(), root: ROOT, iat: 1 }));
    const sig = await s.sign(new TextEncoder().encode(`${h}.${p}`));
    const b64bytes = btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(verifyCard(`${h}.${p}.${b64bytes}`)).rejects.toThrow(/exactly/);
  });

  it("rejects a JWS without the object-card typ", async () => {
    const s = await signer();
    const [, p, sig] = (await signRoot(s.did(), ROOT, s)).split(".") as [string, string, string];
    const h = b64(JSON.stringify({ alg: "EdDSA", kid: didKeyKid(s.did()) }));
    await expect(verifyCard(`${h}.${p}.${sig}`)).rejects.toThrow(/not an object card/);
  });

  it("rejects shapes that are not a compact JWS", async () => {
    await expect(verifyCard("nope")).rejects.toThrow(/compact JWS/);
    await expect(verifyCard("a.b.c")).rejects.toThrow(/header/);
  });

  it("refuses to sign as anything but a did:key", async () => {
    const s = await signer();
    await expect(signRoot("did:web:example.com", ROOT, s)).rejects.toThrow(/did:key/);
  });
});

describe("the card's payload is one text", () => {
  it("rejects a duplicated member, a reordered one, and whitespace, however good the signature", async () => {
    const s = await signer();
    const h = b64(JSON.stringify({ alg: "EdDSA", typ: CARD_TYP, kid: didKeyKid(s.did()) }));
    const texts = [
      `{"did":"${s.did()}","root":"${ROOT}","root":"bafyother"}`,
      `{"root":"${ROOT}","did":"${s.did()}"}`,
      `{"did": "${s.did()}", "root": "${ROOT}"}`,
    ];
    for (const text of texts) {
      const p = b64(text);
      const sig = await s.sign(new TextEncoder().encode(`${h}.${p}`));
      const jws = `${h}.${p}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
      await expect(verifyCard(jws), text).rejects.toThrow(/exactly/);
    }
  });
});
