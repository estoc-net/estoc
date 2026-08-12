# @estoc/did-peer

did:peer:2 and did:peer:4 — encoding, resolution, and conversion to the flat
`DIDDoc` shape [didcomm-rust](https://github.com/sicpa-dlab/didcomm-rust)
expects.

Everything here is pure encoding/decoding. For both peer methods the document
*is* the identifier, so resolution never touches the network — no fetch, no
cache, no store to be out of date. One source runs unchanged in Node (≥18),
Cloudflare workerd, and the browser: sha256 comes from `@noble/hashes`, base64
from `atob`/`btoa`.

```sh
npm install @estoc/did-peer
```

## Usage

```ts
import {
  encodeLongForm,
  resolveDIDCommDoc,
  resolvePeer2,
  toDIDCommDIDDoc,
} from "@estoc/did-peer";

// Mint a did:peer:4 long form from an input document
const did = encodeLongForm({
  verificationMethod: [
    /* ... */
  ],
  service: [
    /* ... */
  ],
});

// Resolve either peer method straight to a didcomm-rust DIDDoc
const didDoc = await resolveDIDCommDoc(did);

// Or work with the raw W3C-shaped document
const raw = resolvePeer2("did:peer:2.Ez6LS...");
const converted = toDIDCommDIDDoc(raw);
```

## What's in

- **did:peer:2** — `isPeerDID2`, `resolvePeer2`
- **did:peer:4** — `isPeerDID4`, `isLongForm`, `isShortForm`, `encodeLongForm`,
  `encodeShortForm`, `longToShort`, `resolveLongForm`, `resolveShortForm`,
  `validateInputDocument`
- **DIDDoc conversion** — `toDIDCommDIDDoc` flattens a W3C DID document into
  didcomm-rust's `DIDDoc`: absolute DID URLs, embedded verification methods
  hoisted, only DIDCommMessaging services retained
- **`resolveDIDCommDoc`** — both peer methods straight to a `DIDDoc`, the
  signature a didcomm resolver wants
- **base64url helpers** — `Buffer`-free, work everywhere

## What's out, by design

Resolver composition (did:web, caching, pinning), WASM loading, and secrets
handling are application policy and stay in the applications. This package is
the shared lineage of [mediator-ts](https://github.com/estoc-net/mediator-ts)
and [didcomm-demo](https://github.com/estoc-net/didcomm-demo), extracted once
three copies agreed byte-for-byte.

## License

Apache-2.0
