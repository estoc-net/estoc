# @estoc/folder-object

Reference implementation of the [folder-object](https://github.com/estoc-net/folder-object) format — *an object is a folder*:

- **read** a mapping (path → bytes) as an object: enumerate the canonical tree (`index.json` + `files/…`), validate the index (format / closure layers, spec §8), drop litter;
- **hash** it to its version identity: the UnixFS root CID, via [`@estoc/signed-dir`](../signed-dir);
- **sign / verify** the bundle card — a JWS over `{did, root}` by a `did:key` (`@estoc/keystore` Signer, so a hardware key fits later);
- **bundle** `{object/, card.jws}` as a directory or a deterministic zip.

Rendering is not here: a format is a fact, a rendering is a projection of it, and each client projects its own way (the app renders `post/1.0` with its own djot renderer inside a sandboxed frame). The command-line tool over these functions is [`@estoc/cli`](../cli) (`estoc object hash|sign|verify|bundle`).

```sh
npm install @estoc/folder-object
```

## API

```ts
import { readObject, hashObject, signObject, verifyObjectCard, zipBundle, readBundle } from "@estoc/folder-object";
import { readTree } from "@estoc/folder-object/fs";

const object = readObject(await readTree("posts/hello/bundle/object"));
const root = await hashObject(object);                 // bafybei…
const jws = await signObject(object, identity.signer); // keystore DidKeySigner
const { matches } = await verifyObjectCard(jws, object);
const zip = zipBundle(object, jws);
```

Everything on the main entry is pure: no IO, no network, no policy — it runs in a browser. `readTree`/`writeTree` (Node `fs`) live on the `@estoc/folder-object/fs` subpath.
