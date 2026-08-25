# @estoc/folder-object

Reference implementation of the [folder-object](https://github.com/estoc-net/folder-object) format — *an object is a folder* — in three layers, one package:

- **tree** — hash a mapping (path → bytes) into a UnixFS merkle DAG under IPIP-499's `unixfs-v1-2025` profile, the same root CID as `ipfs add` (kubo ≥ 0.40), empty directories included; verify an object set against a root; resolve one path block by block, each hop proven against its CID. CID/IPLD **as a format, not as infrastructure**: no DHT, no IPNS, no pinning;
- **object** — read a mapping as an object: enumerate the canonical tree (`index.json` + `files/…`, minus hidden `.`-prefixed entries as the UnixFS profile excludes them), validate the index (format / closure layers, spec §8), drop litter; hash it to its version identity, the root CID;
- **card** — the one signature in the system: a JWS (`typ: estoc/object-card`, EdDSA) over exactly `{did, root}` (any other member makes it malformed) by a `did:key` (an `@estoc/keystore` Signer, so a hardware key fits later). It means one thing — *this DID stands behind this object, as the object's own format defines it* — and nothing else: no expiry, no ordering, no takedown; which version is current is the object's own business (`id`, `updated`). Who *sent* an object is the transport's business; endorsing or replying is a new object that refers to this one;
- **signed object** — `{object/, card.jws}` as a mapping (spec §5); anything beside those two entries is ignored, so a rendered page can live next to the fact it renders.

Rendering is not here: a format is a fact, a rendering is a projection of it, and each client projects its own way (the app renders `post/1.0` with its own djot renderer inside a sandboxed frame). The command-line tool over these functions is [`@estoc/cli`](../cli) (`estoc object hash|sign|verify`); the DIDComm transport is `object-share/1.0` in [`@estoc/agent-core`](../agent-core).

```sh
npm install @estoc/folder-object
```

## API

```ts
import { readObject, hashObject, signObject, verifyObjectCard, signedTree, readAny } from "@estoc/folder-object";
import { readTree, writeTree } from "@estoc/folder-object/fs";   // Node only
import { zipTree, unzipTree } from "@estoc/folder-object/zip";   // fflate; deterministic

const object = readObject(await readTree("posts/hello/object"));
const root = await hashObject(object);                 // bafybei…
const jws = await signObject(object, identity.signer); // keystore DidKeySigner
await writeTree("posts/hello", signedTree(object, jws)); // posts/hello/{object/, card.jws}
const zip = zipTree(signedTree(object, jws));

const { object: got, card } = readAny(unzipTree(zip)); // a signed object or a bare one
const { did, matches } = await verifyObjectCard(card!, got);
```

The tree layer on its own, for callers that carry blocks (agent-core's object-share does):

```ts
import { hashTree, verifyTree, resolvePath } from "@estoc/folder-object";

const { root, nodes, files } = await hashTree(mapping, { dirs: ["drafts"] });
// nodes: every block but single-block files (CID → bytes); files: file CID → path
const { files: paths, dirs } = await verifyTree(root, blocks);
const hit = await resolvePath(root, "files/body.dj", getBlock);
```

Everything on the main entry is pure: no IO, no network, no policy — it runs in Node (≥ 20), workerd and the browser (sha-256 and Ed25519 via WebCrypto).

## Golden vectors

The tree tests pin root CIDs cross-checked against kubo 0.43.0 (a directory tree, a chunked 2 MiB file, a HAMT-sharded directory of 2200 entries, and empty directories alone and nested) plus a raw file CID against an independent sha-256, so a dependency upgrade that shifts canonical encoding fails loudly instead of silently re-rooting every tree.
