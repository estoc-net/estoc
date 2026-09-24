import { createPrivateKey, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";

import { encodeLongForm, longToShort, resolveLongForm, resolveShortForm } from "@estoc/did-peer";
import { base58, base64urlnopad } from "@scure/base";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { deriveContinuity } from "../src/index.js";
import { bindFromPrior, createFromPrior, FROM_PRIOR_PROFILE, inspectFromPrior, InvalidFromPrior, verifyFromPrior, type IssuerEvidence, type Signer, type VerifiedFromPrior } from "../src/from-prior/index.js";

type Party = { longForm: string; shortForm: string; document: IssuerEvidence; shortDocument: IssuerEvidence; kid: string; privateKey: KeyObject; publicKeyBytes: Uint8Array };

function party(name: string): Party {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = base64urlnopad.decode(publicKey.export({ format: "jwk" }).x!);
  const multibase = `z${base58.encode(new Uint8Array([0xed, 0x01, ...publicKeyBytes]))}`;
  const input = {
    verificationMethod: [{ id: "#key-1", type: "Multikey", publicKeyMultibase: multibase }],
    authentication: ["#key-1"],
    service: [{ id: "#service", type: "DIDCommMessaging", serviceEndpoint: { uri: `https://${name}.example`, accept: ["didcomm/v2"] } }],
  };
  const longForm = encodeLongForm(input);
  return {
    longForm,
    shortForm: longToShort(longForm),
    document: { ref: `doc-${name}`, document: resolveLongForm(longForm) },
    shortDocument: { ref: `doc-${name}-short`, document: resolveShortForm(longForm) },
    kid: `${longForm}#key-1`,
    privateKey,
    publicKeyBytes,
  };
}

const IAT = 1_758_700_000;
const b0 = party("b0");
const b1 = party("b1");
const a0 = party("a0");

async function rotation(issuer: Party, successor: Party, header: Record<string, unknown> = {}, claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ iss: issuer.longForm, sub: successor.longForm, iat: IAT, ...claims })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: issuer.kid, ...header } as never)
    .sign(issuer.privateKey);
}

async function ending(issuer: Party, audience: Party | null): Promise<string> {
  return new SignJWT({ iss: issuer.longForm, iat: IAT, ...(audience === null ? {} : { aud: audience.longForm }) })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: issuer.kid })
    .sign(issuer.privateKey);
}

const segments = (jwt: string) => jwt.split(".") as [string, string, string];
const encode = (value: unknown) => base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(value)));

async function failure(promise: Promise<unknown>): Promise<InvalidFromPrior> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof InvalidFromPrior) return err;
    throw err;
  }
  throw new Error("verified");
}

describe("inspect", () => {
  it("reads the header and claims of a token without verifying anything", async () => {
    const jwt = await rotation(b0, b1);
    const [h, p] = segments(jwt);
    const tampered = `${h}.${p}.${base64urlnopad.encode(new Uint8Array(64))}`;
    expect(inspectFromPrior(tampered)).toEqual({ header: { alg: "EdDSA", typ: "JWT", kid: b0.kid }, claims: { iss: b0.longForm, sub: b1.longForm, aud: undefined, iat: IAT } });
    expect(inspectFromPrior(await ending(b0, a0)).claims).toEqual({ iss: b0.longForm, sub: undefined, aud: a0.longForm, iat: IAT });
  });

  it("refuses what is not a JWT of the expected shape", () => {
    const cases = ["", "a.b", "a.b.c", `${encode({ alg: "EdDSA" })}.${encode({ iss: "x", iat: IAT })}.AA`, `${encode({ alg: "EdDSA", kid: "k" })}.${encode({ iss: "x", iat: 1.5 })}.AA`, `${encode({ alg: "EdDSA", kid: "k" })}.${encode({ iss: "x", sub: null, iat: IAT })}.AA`, `${encode({ alg: "EdDSA", kid: "k" })}.${encode({ iss: "x", aud: ["a"], iat: IAT })}.AA`];
    for (const jwt of cases) expect(() => inspectFromPrior(jwt), jwt).toThrow(InvalidFromPrior);
  });

  it("refuses a validity window, so that verification never reads a clock", async () => {
    expect(() => inspectFromPrior(`${encode({ alg: "EdDSA", kid: b0.kid })}.${encode({ iss: b0.longForm, sub: b1.longForm, iat: IAT, exp: IAT + 10 })}.AA`)).toThrow(InvalidFromPrior);
    expect((await failure(verifyFromPrior(await rotation(b0, b1, {}, { nbf: IAT }), b0.document))).failure).toBe("form");
  });
});

describe("verify", () => {
  it("verifies a rotation against the issuer's long-form document", async () => {
    const jwt = await rotation(b0, b1);
    const proof = await verifyFromPrior(jwt, b0.document);
    expect(proof).toMatchObject({
      profile: FROM_PRIOR_PROFILE,
      token: jwt,
      issuer: { presented: b0.longForm, canonical: b0.shortForm },
      change: { kind: "rotate", successor: { presented: b1.longForm, canonical: b1.shortForm } },
      iat: IAT,
      document: { ref: "doc-b0", id: b0.longForm },
      method: b0.kid,
    });
  });

  it("verifies under a short-form document and a short-form kid, and keeps the presented spellings", async () => {
    const jwt = await new SignJWT({ iss: b0.shortForm, sub: b1.shortForm, iat: IAT }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: `${b0.shortForm}#key-1` }).sign(b0.privateKey);
    const proof = await verifyFromPrior(jwt, b0.shortDocument);
    expect(proof.issuer).toEqual({ presented: b0.shortForm, canonical: b0.shortForm });
    expect(proof.document.id).toBe(b0.shortForm);
    const mixed = await verifyFromPrior(await rotation(b0, b1), b0.shortDocument);
    expect(mixed.issuer).toEqual({ presented: b0.longForm, canonical: b0.shortForm });
  });

  it("verifies an ending and retains its audience", async () => {
    const proof = await verifyFromPrior(await ending(b0, a0), b0.document);
    expect(proof.change).toEqual({ kind: "end", audience: { presented: a0.longForm, canonical: a0.shortForm } });
    const unaddressed = await verifyFromPrior(await ending(b0, null), b0.document);
    expect(unaddressed.change).toEqual({ kind: "end", audience: null });
  });

  it("accepts a JWK method too", async () => {
    const jwk = { kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(b0.publicKeyBytes) };
    const document = { ...(b0.document.document as Record<string, unknown>), verificationMethod: [{ id: "#key-1", type: "JsonWebKey2020", publicKeyJwk: jwk }] };
    await expect(verifyFromPrior(await rotation(b0, b1), { ref: "jwk", document })).resolves.toMatchObject({ method: b0.kid });
  });

  it("distinguishes failures of form, profile, document and signature", async () => {
    const jwt = await rotation(b0, b1);
    const [h, p, s] = segments(jwt);
    const payload = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(p))) as Record<string, unknown>;
    const header = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(h))) as Record<string, unknown>;
    const resigned = (hdr: Record<string, unknown>, claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader(hdr as never).sign(b0.privateKey);

    expect((await failure(verifyFromPrior("nope", b0.document))).failure).toBe("form");
    expect((await failure(verifyFromPrior(`${encode({ ...header, alg: "none" })}.${p}.${s}`, b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned({ alg: "EdDSA", kid: b0.kid }, payload), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned({ alg: "EdDSA", typ: "JWT", kid: `${b1.longForm}#key-1` }, payload), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned(header, { ...payload, sub: b0.shortForm }), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned(header, { ...payload, iss: "did:web:b0.example" }), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned(header, { ...payload, sub: "did:key:z6Mk" }), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned(header, { ...payload, aud: a0.longForm }), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned(header, { ...payload, iss: `${b0.longForm.slice(0, -1)}${b0.longForm.endsWith("a") ? "b" : "a"}` }), b0.document))).failure).toBe("profile");

    expect((await failure(verifyFromPrior(jwt, b1.document))).failure).toBe("document");
    expect((await failure(verifyFromPrior(await resigned({ ...header, kid: `${b0.longForm}#key-2` }, payload), b0.document))).failure).toBe("document");
    const unauthorized = { ...(b0.document.document as Record<string, unknown>), authentication: [] };
    expect((await failure(verifyFromPrior(jwt, { ref: "x", document: unauthorized }))).failure).toBe("document");
    const x25519 = { ...(b0.document.document as Record<string, unknown>), verificationMethod: [{ id: "#key-1", type: "Multikey", publicKeyMultibase: `z${base58.encode(new Uint8Array([0xec, 0x01, ...b0.publicKeyBytes]))}` }] };
    expect((await failure(verifyFromPrior(jwt, { ref: "x", document: x25519 }))).failure).toBe("document");
    expect((await failure(verifyFromPrior(jwt, { ref: "x", document: null }))).failure).toBe("document");

    expect((await failure(verifyFromPrior(`${h}.${encode({ ...payload, iat: IAT + 1 })}.${s}`, b0.document))).failure).toBe("signature");
    expect((await failure(verifyFromPrior(`${h}.${p}.${base64urlnopad.encode(new Uint8Array(64))}`, b0.document))).failure).toBe("signature");
    const otherKey = await new SignJWT(payload).setProtectedHeader(header as never).sign(b1.privateKey);
    expect((await failure(verifyFromPrior(otherKey, b0.document))).failure).toBe("signature");
  });

  it("refuses an unencoded payload and unknown critical extensions", async () => {
    const jwt = await rotation(b0, b1);
    const [, p] = segments(jwt);
    const unencoded = `${encode({ alg: "EdDSA", typ: "JWT", kid: b0.kid, b64: false, crit: ["b64"] })}.${new TextDecoder().decode(base64urlnopad.decode(p))}.${base64urlnopad.encode(new Uint8Array(64))}`;
    await expect(verifyFromPrior(unencoded, b0.document)).rejects.toThrow(InvalidFromPrior);
    const input = `${encode({ alg: "EdDSA", typ: "JWT", kid: b0.kid, crit: ["x-ext"], "x-ext": 1 })}.${p}`;
    const critical = `${input}.${base64urlnopad.encode(new Uint8Array(nodeSign(null, new TextEncoder().encode(input), b0.privateKey)))}`;
    expect((await failure(verifyFromPrior(critical, b0.document))).failure).toBe("signature");
  });
});

describe("bind", () => {
  it("binds a rotation to the receipt from the successor and yields a transition and an observation that the model accepts", async () => {
    const jwt = await rotation(b0, b1);
    const proof = await verifyFromPrior(jwt, b0.document);
    const binding = bindFromPrior(proof, { ref: "receipt-1", token: jwt, recipient: a0.longForm, sender: b1.longForm }, { transitionId: "p1", observationId: "o1" });
    expect(binding).toEqual({
      status: "bound",
      facts: [
        { kind: "peer-transition", id: "p1", at: { localDid: a0.shortForm, peerDid: b0.shortForm }, change: { kind: "rotate", successor: b1.shortForm }, receipt: "receipt-1" },
        { kind: "address-observed", id: "o1", at: { localDid: a0.shortForm, peerDid: b1.shortForm }, carriedTransition: "p1", receipt: "receipt-1" },
      ],
    });
    if (binding.status !== "bound") throw new Error(binding.status);
    const model = deriveContinuity(binding.facts);
    expect(model.head({ localDid: a0.shortForm, peerDid: b0.shortForm })).toEqual({ status: "head", channel: { localDid: a0.shortForm, peerDid: b1.shortForm }, support: ["p1"] });
    expect(model.confirmation(a0.shortForm, b0.shortForm)).toMatchObject({ status: "confirmed" });
  });

  it("binds a topology-only transition when no observation ID is given, and accepts the short-form sender", async () => {
    const jwt = await rotation(b0, b1);
    const proof = await verifyFromPrior(jwt, b0.document);
    const binding = bindFromPrior(proof, { ref: "receipt-1", token: jwt, recipient: a0.shortForm, sender: b1.shortForm }, { transitionId: "p1" });
    expect(binding).toMatchObject({ status: "bound", facts: [{ kind: "peer-transition", id: "p1" }] });
  });

  it("reports a mismatch instead of a fact for the wrong token, sender or recipient", async () => {
    const jwt = await rotation(b0, b1);
    const proof = await verifyFromPrior(jwt, b0.document);
    const ids = { transitionId: "p1", observationId: "o1" };
    expect(bindFromPrior(proof, { ref: "r", token: await rotation(b0, b1, {}, { iat: IAT + 1 }), recipient: a0.longForm, sender: b1.longForm }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("token") });
    expect(bindFromPrior(proof, { ref: "r", token: jwt, recipient: a0.longForm, sender: b0.longForm }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("sender") });
    expect(bindFromPrior(proof, { ref: "r", token: jwt, recipient: a0.longForm, sender: null }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("authenticated sender") });
    expect(bindFromPrior(proof, { ref: "r", token: jwt, recipient: b0.longForm, sender: b1.longForm }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("issuer") });
    expect(bindFromPrior(proof, { ref: "r", token: jwt, recipient: b1.longForm, sender: b1.longForm }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("successor") });
    expect(bindFromPrior(proof, { ref: "r", token: jwt, recipient: "did:web:a0.example", sender: b1.longForm }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("did:peer:4") });
  });

  it("binds an ending only to the recipient it names, on an anonymous receipt", async () => {
    const addressed = await ending(b0, a0);
    const proof = await verifyFromPrior(addressed, b0.document);
    expect(bindFromPrior(proof, { ref: "receipt-e", token: addressed, recipient: a0.longForm, sender: null }, { transitionId: "e1" })).toEqual({
      status: "bound",
      facts: [{ kind: "peer-transition", id: "e1", at: { localDid: a0.shortForm, peerDid: b0.shortForm }, change: { kind: "end" }, receipt: "receipt-e" }],
    });
    expect(bindFromPrior(proof, { ref: "receipt-e", token: addressed, recipient: b1.longForm, sender: null }, { transitionId: "e1" })).toMatchObject({ status: "mismatch", because: expect.stringContaining("aud") });
    expect(bindFromPrior(proof, { ref: "receipt-e", token: addressed, recipient: a0.longForm, sender: b0.longForm }, { transitionId: "e1" })).toMatchObject({ status: "mismatch", because: expect.stringContaining("sender") });
    const unaddressed = await ending(b0, null);
    const bare = await verifyFromPrior(unaddressed, b0.document);
    expect(bindFromPrior(bare, { ref: "receipt-e", token: unaddressed, recipient: a0.longForm, sender: null }, { transitionId: "e1" })).toMatchObject({ status: "unbound", because: expect.stringContaining("audience") });
  });
});

describe("create", () => {
  const signerOf = (issuer: Party, methodId = issuer.kid): Signer => ({ methodId, sign: async (input) => new Uint8Array(nodeSign(null, input, issuer.privateKey)) });

  it("creates a rotation proof that verifies and binds like a received one", async () => {
    const proof = await createFromPrior({ issuer: b0.longForm, change: { kind: "rotate", successor: b1.longForm }, iat: IAT, evidence: b0.document }, signerOf(b0));
    expect(proof).toMatchObject({ issuer: { presented: b0.longForm }, change: { kind: "rotate", successor: { presented: b1.longForm } }, iat: IAT, method: b0.kid });
    expect(inspectFromPrior(proof.token)).toEqual({ header: { alg: "EdDSA", typ: "JWT", kid: b0.kid }, claims: { iss: b0.longForm, sub: b1.longForm, aud: undefined, iat: IAT } });
    const again = await verifyFromPrior(proof.token, b0.document);
    expect(again.token).toBe(proof.token);
    expect(bindFromPrior(again, { ref: "r", token: proof.token, recipient: a0.longForm, sender: b1.longForm }, { transitionId: "p1" })).toMatchObject({ status: "bound" });
  });

  it("creates an ending proof addressed to the peer", async () => {
    const proof = await createFromPrior({ issuer: b0.longForm, change: { kind: "end", audience: a0.longForm }, iat: IAT, evidence: b0.document }, signerOf(b0));
    expect(proof.change).toEqual({ kind: "end", audience: { presented: a0.longForm, canonical: a0.shortForm } });
    expect(inspectFromPrior(proof.token).claims).toEqual({ iss: b0.longForm, sub: undefined, aud: a0.longForm, iat: IAT });
  });

  it("refuses a signer whose method the issuer does not authorize, or whose signature does not verify", async () => {
    const request = { issuer: b0.longForm, change: { kind: "rotate" as const, successor: b1.longForm }, iat: IAT, evidence: b0.document };
    expect((await failure(createFromPrior(request, signerOf(b0, `${b0.longForm}#key-2`)))).failure).toBe("document");
    expect((await failure(createFromPrior(request, signerOf(b1, b0.kid)))).failure).toBe("signature");
    expect((await failure(createFromPrior(request, { methodId: b0.kid, sign: async () => new Uint8Array(3) }))).failure).toBe("signature");
    expect((await failure(createFromPrior(request, { methodId: b0.kid, sign: async () => "sig" as unknown as Uint8Array }))).failure).toBe("signature");
  });

  it("refuses an inconsistent request before signing", async () => {
    let signed = 0;
    const counting: Signer = { methodId: b0.kid, sign: async (input) => (signed++, new Uint8Array(nodeSign(null, input, b0.privateKey))) };
    expect((await failure(createFromPrior({ issuer: b0.longForm, change: { kind: "rotate", successor: b0.shortForm }, iat: IAT, evidence: b0.document }, counting))).failure).toBe("profile");
    expect((await failure(createFromPrior({ issuer: b0.longForm, change: { kind: "rotate", successor: b1.longForm }, iat: 1.5, evidence: b0.document }, counting))).failure).toBe("profile");
    expect((await failure(createFromPrior({ issuer: "did:web:b0.example", change: { kind: "rotate", successor: b1.longForm }, iat: IAT, evidence: b0.document }, counting))).failure).toBe("profile");
    expect(signed).toBe(0);
  });

  it("works with a non-exportable key held by the host", async () => {
    const pem = b0.privateKey.export({ format: "pem", type: "pkcs8" });
    const held = createPrivateKey(pem);
    const signer: Signer = { methodId: b0.kid, sign: async (input) => new Uint8Array(nodeSign(null, input, held)) };
    const proof: VerifiedFromPrior = await createFromPrior({ issuer: b0.longForm, change: { kind: "rotate", successor: b1.longForm }, iat: IAT, evidence: b0.document }, signer);
    await expect(verifyFromPrior(proof.token, b0.document)).resolves.toBeDefined();
  });
});
