# @estoc/keystore

An encrypted did:key keystore as a plain JSON document — one sealed seed,
every key derived from it by name — and the `Signer` handle that keeps
private keys where they belong.

The design rule: **the store's API never yields private key bytes.** Deriving
a key returns a `Signer` — the same contract as a WebCrypto
non-extractable key or a hardware wallet — so anything that hands out
Signers is interchangeable to callers, and a future hardware-backed
implementation slots in without touching them. `Signer` covers signing;
`DidKeySigner` (what this store returns) adds X25519 key agreement, because
the did:key convention derives a `keyAgreement` key from the Ed25519 key and
DIDComm decryption needs the private ECDH operation. The two are separate
interfaces on purpose: hardware devices commonly sign Ed25519 but don't do
X25519 ECDH, so a hardware-backed `Signer` may never implement the second.

Everything is data-in/data-out: this package reads and writes *documents*,
never files. Where the sealed seed lives (the vault's SQLite database,
browser storage, KV) is the application's business. One source runs
unchanged in Node (≥20), Cloudflare workerd, and the browser: curves from
`@noble/curves`, HKDF and JWE on WebCrypto (JWE via
[`jose`](https://github.com/panva/jose)).

Only standards inside: the seed is sealed as a compact JWE (RFC 7516) with
`PBES2-HS512+A256KW` / `A256GCM` at 220k iterations (current OWASP
recommendation); keys derive with HKDF-SHA256 (RFC 5869); the escape hatch
yields OKP JWKs (RFC 8037).

```sh
npm install @estoc/keystore
```

## One seed, every key derived by name

Sealing each key on its own is fine for a handful of keys and wrong for
pairwise DIDs (one identity per relationship means dozens of keys and one
PBKDF2 run per key on every unlock). The store seals a single 32-byte seed
and derives every key from it with HKDF-SHA256:

```
salt = "estoc-keystore"
info = "estoc/v3/<ed25519|x25519>/<name>"
```

**The name is the derivation path.** Names match `[A-Za-z0-9._/-]+`; the
same seed and the same name always give the same key, so there is no
index, no counter and no allocation table, and the store lists nothing:
which names are in use is for whoever holds the store to record (the
vault's events do). The flip side is the caller's rule: a name is never reused for a different key. Name keys after
the id of the thing they belong to (`pair/<contact-id>/<uuid>`), not after
a position.

The Ed25519 and X25519 halves of an identity are derived independently —
no Ed→X conversion — so a future hardware signer can hold one while
software holds the other.

```ts
import { createSeedKeystore, deriveIdentity, parseSeedKeystore, unlockSeedKeystore } from "@estoc/keystore";

// Once: create (or restore) the store; the seed key comes back already imported.
const { doc, seedKey } = await createSeedKeystore(passphrase);
const identity = await deriveIdentity(seedKey, "anchor");
identity.did;                 // did:key:z6Mk... (the Ed25519 half)
identity.signer;              // DidKeySigner: sign + X25519 ECDH
identity.privateJwks();       // escape hatch: OKP JWKs for libraries that run their own crypto

// Once per installation: unlock → a non-extractable WebCrypto HKDF key.
const unlocked = await unlockSeedKeystore(parseSeedKeystore(json), passphrase);
// Keep it (it survives structured clone, so IndexedDB works);
// every later derivation is passphrase-free:
const anchor = await deriveIdentity(unlocked, "anchor");
```

`changeSeedPassphrase` re-seals the seed; `serializeKeystore` writes the
document.

On the escape hatch: the rule "the API never yields private key bytes"
holds for `signer`. `privateJwks()` exists because some libraries
(didcomm-rust's secrets resolver, for one) cannot call out to a Signer;
use it only where that is the case, and note the non-extractable seed key
still means the *seed* is never handed out — only individual derived keys.

## Document format

Version 3:

```json
{
  "version": 3,
  "seedJwe": "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIi..."
}
```

Readers keep fields they do not know about, so a document may carry more
than this. Earlier formats are refused, not migrated: v1 (0.1.x) sealed
each key as its own JWE, v2 (0.2.x) derived by index under the label
`estoc/v1` — neither holds keys this version can reach by name. A version-3
document that lists `keys` (0.3.x, the cache a folder-format vault kept)
is refused as well.
