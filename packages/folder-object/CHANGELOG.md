# Changelog

## Unreleased — the DASL encoding, on a subpath

An experiment on the `dasl` branch, beside the UnixFS tree, not instead
of it (folder-object spec, `dasl` branch, §2.1): the tree hashed as
[DASL](https://dasl.ing/) — files as whole raw blocks, the tree as one
DRISL document in the shape of a MASL bundle, the root its drisl CID.

- `@estoc/folder-object/dasl`: `hashTree` / `verifyTree` / `resolvePath`
  over a manifest (`{resources: {"/path": {src, size}}}`), a strict DRISL
  codec (`encodeDrisl` / `decodeDrisl`: one byte string per value, every
  other refused), DASL CIDs (`rawCid` / `drislCid` / `parseCid`, 36
  bytes, base32 lower, the canonical spelling only), `encodeManifest` /
  `decodeManifest` (closed shape; the decoded value must re-encode to the
  block's bytes; one `src` one `size`; at most `MAX_MANIFEST_BYTES`,
  1 MiB), and the object and card layers over that root (`hashObject`,
  `signObject`, `verifyCard` — the root must be a manifest CID —
  `verifyObjectCard`, and `verifyObject`: the object read out of a root,
  refusing a manifest that names anything but a canonical tree instead
  of filtering it). `verifyTree` takes `maxLeafBytes`: a leaf stated
  larger is never fetched and is reported in `declined` — unverifiable
  by this reader, not missing, not malformed. No dependency: sha-256 is
  WebCrypto's, base32 and CBOR are here. Bundled for the browser the
  subpath is 15 kB minified (6 kB gzip) against 155 kB (49 kB) for the
  UnixFS entry.
- The card's payload is one text: `verifyCard` (main entry) now requires
  the payload to be exactly `{"did":…,"root":…}` — the two members, each
  once, in that order, no whitespace, as `signRoot` and the Ledger signer
  write it — so no two JSON parsers can disagree about what one signature
  attests (a duplicated `root` member used to pass the member count).
- Golden vectors: the sea-day fixture roots at
  `bafyreicdsejj526l225wrfl5cpxcgehq4pzbpxphocvmiuvy6dpwi467aa`, its
  manifest pinned byte for byte, cross-checked against an independent
  Python encoder, `@ipld/dag-cbor` + `multiformats`, and `@atcute/cbor`
  (dev dependencies, for the tests only).
- The main entry, `estoc object …`, object-share and the vault's block
  store are unchanged: they still speak UnixFS.

## 0.6.0 — 2026-08-26

The closure as one file, for the package road (`estoc/docs/object-share.md`
§8).

- `encodeCar(roots, blocks)` / `decodeCar(bytes)`: CARv1 with a
  hand-encoded dag-cbor header — no CBOR dependency. Decoding checks
  every block against its CID and leaves out the ones that do not match
  (listed in `bad`), so every byte returned is named truthfully.
- `blobHash(bytes)` / `isBlobHash(name)`: the sha-256 multihash in
  base32 lower that names a blob (`estoc/docs/blob-store.md`).

## 0.5.0 — 2026-08-26

The tree's skeleton apart from its leaves, for sharing an object before
its bytes (`estoc/docs/object-share.md` §2, §7).

- `verifyTree(root, objects, { leaves: "optional" })`: every dag-pb
  block — directory nodes, HAMT shards, chunk indexes — is still
  required, but a raw block may be absent. The result gains `missing`
  (absent raw CID → the size its link claims) and `partial` (file path →
  its absent CIDs, for every file with one); both are empty under the default
  `leaves: "required"`, where an absent leaf throws as before. A present
  leaf is still hashed against its CID.
- `verifyTree` accepts a lookup function (`GetBlock`) as the object set,
  not only a map.
- The verify walk decodes dag-pb / UnixFS nodes itself instead of pulling
  leaves through `ipfs-unixfs-exporter`; `@ipld/dag-pb` and `ipfs-unixfs`
  become runtime dependencies. Roots and verdicts are unchanged (golden
  vectors, HAMT fixture).

## 0.4.0 — 2026-08-24

One package for the three layers. `@estoc/signed-dir` is retired: its
UnixFS tree (`hashTree`/`verifyTree`/`resolvePath`, golden vectors and
all) moves in here unchanged, and its half of the card joins the other
half, so the card has one home and one meaning.

- **Breaking:** hidden entries — any path segment beginning with `.` —
  are not part of an object's tree (`isHidden`), matching the
  `unixfs-v1-2025` profile's default so a folder hashes as `ipfs add -r`
  does; `readTree` skips them, and it now throws on a symbolic link (or
  any non-regular entry) instead of silently dropping it — a fact holds
  only files.
- **Breaking:** the card is a JWS with `typ: estoc/object-card`; a card
  without it does not verify. Its payload is exactly `{did, root}`; any
  other member makes it malformed (a card is closed testimony — new
  meaning is a new `typ`, not a new field). `signRoot(did, root, signer)` /
  `verifyCard(jws)` replace signed-dir's `createCard`/`verifyCard` — the
  did:key rule (payload `did` is a did:key, `kid` its one method) is now
  the card's, not the caller's. `RootCard` is `ObjectCard`.
- **Breaking:** "bundle" is gone as a word and a verb. A *signed object*
  is `{object/, card.jws}`: `signedTree(object, card)` lays it out,
  `readAny(mapping)` recognizes a signed object or a bare one,
  `readSignedObject` insists on the card. Anything beside `object/` and
  `card.jws` is ignored, so a post directory with its rendered page *is*
  the signed object. `Bundle`, `bundleTree`, `readBundle`, `zipBundle`,
  `unzipMapping` are removed.
- The zip container is its own subpath, `@estoc/folder-object/zip`
  (`zipTree`/`unzipTree`), generic over mappings.
- `writeTree` (`/fs`) replaces the top-level entries it writes and leaves
  the rest of the directory alone.
- Depends on `ipfs-unixfs-importer`/`-exporter` and `multiformats`
  directly; no longer on `@estoc/signed-dir`.

## 0.3.0 — 2026-08-24

- **Breaking:** the `estoc-object` CLI and the `post/1.0` renderer
  (`renderPost`, `fillTemplate`, `POST_FORMAT`) are gone. The package is
  the format only — read/validate/hash/sign/verify/bundle. The CLI lives
  on as `estoc object …` in `@estoc/cli`; the renderer moved into the app
  (`app/src/core/post.ts`), where projection belongs. `@djot/djot` is no
  longer a dependency.

## 0.2.0 — 2026-08-24

- **Breaking:** `readTree`/`writeTree` moved to the `@estoc/folder-object/fs`
  subpath so the main entry pulls no `node:fs` and bundles for the browser
  (the app renders shared objects with it).

## 0.1.0 — 2026-08-24

- First release: read/validate/hash objects, did:key bundle cards, bundle dir/zip, post/1.0 djot renderer, `estoc-object` CLI.
