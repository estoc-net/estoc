# @estoc/folder-object

Reference implementation of the [folder-object](https://github.com/estoc-net/folder-object) format — *an object is a folder*:

- **read** a mapping (path → bytes) as an object: enumerate the canonical tree (`index.json` + `files/…`), validate the index (format / closure layers, spec §8), drop litter;
- **hash** it to its version identity: the UnixFS root CID, via [`@estoc/signed-dir`](../signed-dir);
- **sign / verify** the bundle card — a JWS over `{did, root}` by a `did:key` (`@estoc/keystore` Signer, so a hardware key fits later);
- **bundle** `{object/, card.jws}` as a directory or a deterministic zip;
- **render** a `post/1.0` object to HTML (djot body, in-tree `files/…` references rewritten, raw HTML dropped, no network).

```sh
npm install @estoc/folder-object
```

## CLI

```
estoc-object key init   --keystore org.json --key org/estoc     # new v3 keystore (or add a key); prints did:key
estoc-object key list   --keystore org.json
estoc-object hash       <objectDir>
estoc-object sign       <objectDir> --keystore org.json --key org/estoc --out card.jws
estoc-object bundle     <objectDir> --card card.jws --out <bundleDir> --zip <file.zip>
estoc-object verify     <bundleDir | file.zip | objectDir> [--card card.jws]
estoc-object render     <objectDir> --template page.html [--assets <urlBase>] --out index.html
```

The passphrase comes from `ESTOC_PASSPHRASE` or a no-echo prompt. Templates use `{{title}}`, `{{summary}}`, `{{published}}`, `{{publishedDate}}`, `{{updated}}`, `{{lang}}`, `{{tags}}`, `{{id}}`, `{{root}}`, `{{body}}`.

## API

```ts
import { readObject, hashObject, signObject, verifyObjectCard, zipBundle, readBundle, renderPost } from "@estoc/folder-object";
import { readTree } from "@estoc/folder-object/fs";

const object = readObject(await readTree("posts/hello/bundle/object"));
const root = await hashObject(object);                 // bafybei…
const jws = await signObject(object, identity.signer); // keystore DidKeySigner
const { matches } = await verifyObjectCard(jws, object);
const zip = zipBundle(object, jws);
const { bodyHtml, title } = renderPost(object, { assetBase: "bundle/object" });
```

Everything on the main entry is pure: no IO, no network, no policy — it runs in a browser. `readTree`/`writeTree` (Node `fs`) live on the `@estoc/folder-object/fs` subpath.
