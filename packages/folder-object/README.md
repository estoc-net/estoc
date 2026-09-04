# @estoc/folder-object

Reference implementation of the [folder-object](https://github.com/estoc-net/folder-object) format — *an object is a folder* — in three layers, one package:

- **tree** — hash a mapping (path → bytes) as [DASL](https://dasl.ing/): every file one raw block hashed whole, the tree one DRISL document — a MASL bundle `{resources: {"/path": {src, size}}}` — and the root its drisl CID (spec §2.1). No directory nodes, no chunking, no sharding: verifying a tree is one block for its shape and one per file for its bytes; resolving a path is two fetches, whatever the depth. The manifest is derived, never authored, and a reader refuses one that is not the canonical form — other bytes for its value, another member, a path a file tree cannot hold, one `src` under two sizes, more than 1 MiB — so one mapping has one root and a root reaches one mapping. CID/IPLD **as a format, not as infrastructure**: no DHT, no IPNS, no pinning;
- **object** — read a mapping as an object: enumerate the canonical tree (`index.json` + `files/…`, minus hidden `.`-prefixed entries, spec §4), validate the index (format / closure layers, spec §8), drop litter; hash it to its version identity, the manifest root. Read an object back out of a root and the blocks at hand (`verifyObject`): the manifest must name exactly a canonical tree — a root that reaches litter is no object's — and a leaf not yet here is a partial object, never a defect;
- **card** — the one signature in the system: a JWS (`typ: estoc/object-card`, EdDSA) over exactly the text `{"did":…,"root":…}` (any other payload makes it malformed) by a `did:key` (an `@estoc/keystore` Signer, so a hardware key fits later), whose `root` is a manifest CID and nothing else. It means one thing — *this DID stands behind this object, as the object's own format defines it*; which version is current is the object's own business (`id`, `updated`). Who *sent* an object is the transport's business; endorsing or replying is a new object that refers to this one;
- **signed object** — `{object/, card.jws}` as a mapping (spec §5); anything beside those two entries is ignored, so a rendered page can live next to the fact it renders.

The primitives — DASL CIDs, the DRISL codec, DASL CAR — are [`@estoc/dasl`](../dasl)'s, the one codec every reader of a block in this workspace decodes with. Rendering is not here: a format is a fact, a rendering is a projection of it, and each client projects its own way (the app renders `post/1.0` with its own Markdown renderer inside a sandboxed frame). The command-line tool over these functions is [`@estoc/cli`](../cli) (`estoc object hash|sign|verify`); the DIDComm transport is `object-share/1.0` in [`@estoc/agent-core`](../agent-core).

```sh
npm install @estoc/folder-object
```

## API

```ts
import { readObject, hashObject, signObject, verifyObjectCard, signedTree, readAny } from "@estoc/folder-object";
import { readTree, writeTree } from "@estoc/folder-object/fs";   // Node only
import { zipTree, unzipTree } from "@estoc/folder-object/zip";   // fflate; deterministic

const object = readObject(await readTree("posts/hello/object"));
const root = await hashObject(object);                 // bafyrei…
const jws = await signObject(object, identity.signer); // keystore DidKeySigner
await writeTree("posts/hello", signedTree(object, jws)); // posts/hello/{object/, card.jws}
const zip = zipTree(signedTree(object, jws));

const { object: got, card } = readAny(unzipTree(zip)); // a signed object or a bare one
const { did, matches } = await verifyObjectCard(card!, got);
```

The tree layer on its own, for callers that carry blocks (agent-core's object-share does):

```ts
import { hashTree, verifyTree, verifyObject, resolvePath } from "@estoc/folder-object";

const { root, manifest, entries, files } = await hashTree(mapping);
// manifest: the one DRISL block; entries: path, raw CID, size; files: file CID → path
const tree = await verifyTree(root, blocks, { leaves: "optional", maxLeafBytes: 32 * 1024 * 1024 });
// tree.files, tree.sizes: every path; tree.partial: leaves not here; tree.declined: leaves past the bound
const { object, complete } = await verifyObject(root, getBlock, { leaves: "optional" });
const hit = await resolvePath(root, "files/body.md", getBlock);
```

A manifest is untrusted input: laying its paths out is linear in their bytes whatever their depth, a leaf is never hashed past `maxLeafBytes` whatever its stated `size` (a claim, checked on what arrives), and a manifest is never read past 1 MiB. Projecting a mapping onto a file system (`writeTree`) places every path first — each segment one entry name on this platform, the whole inside the directory given — before anything is removed or written.

Everything on the main entry is pure: no IO, no network, no policy — it runs in Node (≥ 20), workerd and the browser (sha-256 and Ed25519 via WebCrypto).

## Golden vectors

The tree tests pin the sea-day example's root (`bafyreicdsejj526l225wrfl5cpxcgehq4pzbpxphocvmiuvy6dpwi467aa`) and its manifest byte for byte, cross-checked against an independent encoder and against `@ipld/dag-cbor` + `multiformats` building the same document (dev dependencies, for the tests only), so an edit that shifts the canonical encoding fails loudly instead of silently re-rooting every tree.
