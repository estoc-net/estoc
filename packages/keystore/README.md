# @estoc/keystore

An encrypted did:key keystore as a plain JSON document, and the `Signer`
handle that keeps private keys where they belong.

The design rule: **the store's API never yields private key bytes.** Opening
an entry returns a `Signer` — the same contract as a WebCrypto
non-extractable key or a hardware wallet — so anything that hands out
Signers is interchangeable to callers, and a future hardware-backed
implementation slots in without touching them.

Everything is data-in/data-out: this package reads and writes *documents*,
never files. Where the JSON lives (`~/.estoc/keystore.json`, browser
storage, KV) is the application's business. One source runs unchanged in
Node (≥20), Cloudflare workerd, and the browser: curves from
`@noble/curves`, JWE via [`jose`](https://github.com/panva/jose) on
WebCrypto.

Only standards inside: private keys are OKP Ed25519 JWKs (RFC 8037), sealed
as compact JWEs (RFC 7516) with `PBES2-HS512+A256KW` / `A256GCM` at 220k
iterations (current OWASP recommendation). Names and DIDs stay in
cleartext — they're public information, so listing needs no passphrase.

```sh
npm install @estoc/keystore
```

## Usage

```ts
import {
  createKey,
  emptyKeystore,
  listKeys,
  openKey,
  parseKeystore,
  serializeKeystore,
} from "@estoc/keystore";

// Create a key; persist the returned document wherever you like.
const { doc, signer } = await createKey(emptyKeystore(), "root", passphrase);
await writeFile(path, serializeKeystore(doc), { mode: 0o600 });

console.log(signer.did()); // did:key:z6Mk...

// Later: load, list without a passphrase, open with one.
const loaded = parseKeystore(await readFile(path, "utf8"));
listKeys(loaded); // [{ name: "root", did: "did:key:z6Mk...", createdAt: "..." }]
const root = await openKey(loaded, "root", passphrase);

const signature = await root.sign(bytes); // Ed25519
```

`Signer` covers signing; `DidKeySigner` (what this store returns) adds
X25519 key agreement, because the did:key convention derives a
`keyAgreement` key from the Ed25519 key and DIDComm decryption needs the
private ECDH operation:

```ts
const secret = await root.deriveSharedSecret(theirX25519PublicKey);
```

The two capabilities are deliberately separate interfaces: hardware devices
commonly sign Ed25519 but don't do X25519 ECDH, so a hardware-backed
`Signer` may never implement the second one.

## Document format

```json
{
  "version": 1,
  "keys": [
    {
      "name": "root",
      "did": "did:key:z6Mk...",
      "createdAt": "2026-08-13T00:00:00.000Z",
      "privateKeyJwe": "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIi..."
    }
  ]
}
```

Each entry is sealed independently, so a store can mix passphrases and, later,
entries that reference keys held elsewhere.

## License

Apache-2.0
