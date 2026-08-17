# @estoc/keystore

An encrypted did:key keystore as a plain JSON document — per-key (v1) or
seed-derived (v3) — and the `Signer` handle that keeps private keys where they belong.

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

## Seed keystore (v3): one seed, every key derived by name

The v1 store seals each key on its own, which is fine for a handful of keys
and wrong for pairwise DIDs (one identity per relationship means dozens of
keys and one PBKDF2 run per key on every unlock). The v3 store seals a
single 32-byte seed and derives every key from it with HKDF-SHA256:

```
salt = "estoc-keystore"
info = "estoc/v3/<ed25519|x25519>/<name>"
```

**The name is the derivation path.** Names match `[A-Za-z0-9._/-]+`; the
same seed and the same name always give the same key, so there is no
index, no counter and no allocation table — `keys[]` in the document is a
cache (name, DID, first-seen time) so listing needs no unlock, and a name
that appears anywhere else (an application's config, a contact record)
derives whether or not this store has listed it. The flip side is the
caller's rule: a name is never reused for a different key. Name keys after
the id of the thing they belong to (`pair/<contact-id>/<uuid>`), not after
a position.

The Ed25519 and X25519 halves of an identity are derived independently —
no Ed→X conversion — so a future hardware signer can hold one while
software holds the other.

```ts
import {
  addDerivedKey,
  createSeedKeystore,
  openDerivedKey,
  parseSeedKeystore,
  serializeKeystore,
  unlockSeedKeystore,
} from "@estoc/keystore";

// Once: create (or restore) the store; the seed key comes back already imported.
let { doc, seedKey } = await createSeedKeystore(passphrase);
let identity;
({ doc, identity } = await addDerivedKey(doc, seedKey, "anchor"));
identity.did;                 // did:key:z6Mk... (the Ed25519 half)
identity.signer;              // DidKeySigner: sign + X25519 ECDH
identity.privateJwks();       // escape hatch: OKP JWKs for libraries that run their own crypto

// Once per installation: unlock → a non-extractable WebCrypto HKDF key.
const loaded = parseSeedKeystore(json);
seedKey = await unlockSeedKeystore(loaded, passphrase);
// Keep `seedKey` (it survives structured clone, so IndexedDB works);
// every later derivation is passphrase-free:
const anchor = await openDerivedKey(loaded, seedKey, "anchor");
```

`addDerivedKey` is idempotent by name (adding a listed name re-derives,
checks the recorded DID, returns the document unchanged);
`openDerivedKey` derives from the name and only checks the cache entry if
there is one; `removeDerivedKey` forgets the listing, not the key.
`deriveIdentity(seedKey, name)` is the raw operation underneath, for
callers that manage their own list. `changeSeedPassphrase` re-seals the
seed; `listKeys` and `serializeKeystore` accept either store version.

On the escape hatch: the rule "the API never yields private key bytes"
holds for `signer`. `privateJwks()` exists because some libraries
(didcomm-rust's secrets resolver, for one) cannot call out to a Signer;
use it only where that is the case, and note the non-extractable seed key
still means the *seed* is never handed out — only individual derived keys.

## Document formats

v3 (seed):

```json
{
  "version": 3,
  "seedJwe": "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIi...",
  "keys": [
    { "name": "anchor", "did": "did:key:z6Mk...", "createdAt": "2026-08-17T00:00:00.000Z" },
    { "name": "pair/0198a.../0198b...", "did": "did:key:z6Mk...", "createdAt": "2026-08-17T00:00:00.000Z" }
  ]
}
```

Readers keep fields they do not know about, so a document may carry more
than this. v2 (`nextIndex` + per-key `index`, label `estoc/v1`) was the
0.2.x format; it is refused, not migrated — its DIDs derive differently.

v1 (per-key):

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
