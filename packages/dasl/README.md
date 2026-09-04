# @estoc/dasl

[DASL](https://dasl.ing/) — CIDs, DRISL, CAR — with no dependency: sha-256 is WebCrypto's; base32, CBOR and varints are a few dozen lines each. About 600 lines, pure functions, runs in Node (≥ 20), workerd and the browser.

- **CID** — a DASL CID is CIDv1, sha-256, codec `raw` (0x55, bare bytes) or `drisl` (0x71, a DRISL document), always 36 bytes, written in base32 lower (`b…`, 59 characters) and nothing else: no CIDv0, no dag-pb, no other hash, no other base, no uppercase. `parseCid` takes the one canonical spelling; `rawCid` / `drislCid` name bytes; `checkCid` proves bytes against a name under its own codec.
- **DRISL** — deterministic CBOR with CIDs as tag 42 (the CBOR/c-42 profile). `encodeDrisl` writes the one byte string a value has; `decodeDrisl` refuses every other form — non-shortest integers and lengths, indefinite lengths, keys out of bytewise order, tags other than 42, links that are not DASL CIDs, floats narrower than 64 bits, NaN, infinities, negative zero, invalid UTF-8, trailing bytes — so a block that decodes is a block whose bytes are the only bytes its value can have, and its CID is a function of its content. A decoded map has no prototype: every key DRISL allows is a plain own property.
- **CAR** — a DASL CAR is CARv1 whose header is a DRISL map `{roots, version: 1}` and whose blocks are named by exactly the 36 bytes of a DASL CID. `decodeCar` checks every block against its name and keeps only what matches (`bad` lists the rest); `encodeCar` writes roots and blocks in the order given.

```sh
npm install @estoc/dasl
```

## API

```ts
import { rawCid, drislCid, parseCid, checkCid, encodeDrisl, decodeDrisl, Link, encodeCar, decodeCar } from "@estoc/dasl";

const leaf = await rawCid(bytes);                              // bafkrei…
const doc = encodeDrisl({ resources: { "/a": { src: new Link(parseCid(leaf)), size: bytes.length } } });
const root = await drislCid(doc);                              // bafyrei…
decodeDrisl(doc);                                              // the value back, or a throw on any non-canonical byte
await checkCid(leaf, bytes);                                   // throws unless bytes hash to leaf

const car = encodeCar([root], new Map([[root, doc], [leaf, bytes]]));
const { roots, blocks, bad } = await decodeCar(car);           // blocks: only what hashes to its name
```

The tests pin RFC 8949 vectors, refuse some forty non-canonical encodings, and cross-check the encoder byte for byte against `@ipld/dag-cbor` and `@atcute/cbor` (dev dependencies, for the tests only). What a DRISL document *means* — a [folder-object](https://github.com/estoc-net/folder-object) manifest, say — is [`@estoc/folder-object`](../folder-object)'s business, not this package's.
