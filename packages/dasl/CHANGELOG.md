# Changelog

## 0.1.0 — Unreleased

First release: the primitives the folder-object format is encoded in,
in a package of their own so that every reader of a block — the
folder-object format, the vault's block store, the object-share
protocol — decodes with one codec and roots the same document the same
way.

- DASL CIDs (`parseCid`, `cidFromBytes`, `cidOf`, `rawCid`, `drislCid`,
  `checkCid`, `codecOf`, `isDaslCid`): CIDv1, sha-256, codec raw (0x55)
  or drisl (0x71), 36 bytes, base32 lower in the one canonical spelling;
  anything else — CIDv0, dag-pb, another hash, another base, uppercase —
  is not a DASL CID.
- DRISL (`encodeDrisl`, `decodeDrisl`, `Link`): the CBOR/c-42 profile.
  The encoder writes shortest forms, definite lengths, keys in bytewise
  order of their encoding, tag 42 over `0x00 ‖ CID`; the decoder refuses
  every other form (non-shortest heads, indefinite lengths, unsorted or
  duplicate keys, tags other than 42, non-DASL links, simple values
  beyond false/true/null, floats narrower than 64 bits, NaN, infinities,
  negative zero, invalid UTF-8, trailing bytes, nesting past
  `MAX_DEPTH`). A decoded map has no prototype, so any key DRISL allows
  — `__proto__` included — is a plain own property, and a document the
  encoder writes decodes back to itself.
- DASL CAR (`encodeCar`, `decodeCar`): CARv1 whose header is a DRISL map
  `{roots, version: 1}` and whose every block is named by exactly the
  36 bytes of a DASL CID; a block named otherwise, or whose bytes do not
  hash to its name, is dropped and listed in `bad`, never kept.
