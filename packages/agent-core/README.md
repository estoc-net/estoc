# @estoc/agent-core

The DIDComm v2 agent behind Estoc's clients: mediation (coordinate-mediation
3.0), pickup and live delivery (messagepickup 3.0 over HTTP and WebSocket),
routing 2.0 forwards packed by hand, layer by layer, and user-profile/1.0
introductions, all over an `.estoc` vault stored through a pluggable
backend.

Runs wherever didcomm-rust's WASM does: the browser (Vite), workerd, Node.
The WASM itself is *not* loaded here — see [Didcomm API](#didcomm-api).

## Layers

```
Agent                        mediation · pickup · live delivery · routing
  ├─ protocol/               type URIs, resolver (did:web + did:peer), mediator input, chat projection
  ├─ identity/               did:peer:4 from a seed-derived identity (@estoc/keystore v2)
  └─ Vault                   the .estoc format: config · keystore · contacts · message log
       └─ VaultBackend       bytes: OpfsBackend (browser) · MemoryBackend (tests, snapshots)
```

### The vault format

```
.estoc/
  config.json            label, identity anchor, mediation snapshot
  keystore.json          @estoc/keystore v2 — one sealed seed + a plaintext key index
  contacts/<name>.json   one mutable record per contact, cid-anchored, DID history with evidence
  messages/NNNN.jsonl    append-only log; readers concatenate every segment
```

- **DIDs in config are snapshots**, recorded when minted, and checked against
  the seed on open (`Vault.peerIdentity`). Rotating a mediator later never
  silently renames an identity.
- **Contacts** are keyed by `cid` (uuidv7). Their DIDs form a history
  (`dids[]`, closed with `until`, hops proven by `fromPrior`), and — for
  pairwise relationships — so do ours (`myDids[]` with `keyIndex`). The
  file name is a readable handle derived from the petname; the record is
  the truth.
- **The message log** stores each event as
  `{mid, at, direction, sender?, msg}`: `mid` is the local primary key
  (uuidv7, assigned at append), `msg` the plaintext exactly as it arrived
  or left, `sender` the DID the envelope *proved* (didcomm-rust never
  compares it with `from`).
  Whose message it is gets resolved at read time through contact DID
  histories — the log encodes facts, not interpretations. A line that does
  not parse (a crash mid-append, a corrupted byte) is reported to the reader
  and skipped, never fatal; the next append after a cut-short line first
  gives the fragment its own terminator so the two never fuse. Appends are
  serialised per `MessageLog` instance.
- **Attribution is the envelope's.** Inbound mail is attributed to the DID
  the authcrypt layer proves, never to the plaintext `from` (which anyone
  can type into an anonymous envelope). Anonymous mail is logged with
  `sender: null`, belongs to no contact's thread (`chatView` yields null),
  and cannot rename a contact or be answered with a profile.
- **At rest, the vault is plaintext** apart from the seed: messages and
  contacts are readable files. An application wanting encryption at rest
  wraps the backend.
- **One agent per vault at a time.** Two agents (two tabs) on one vault
  would append to the same log and rewrite the same config; the package
  does not arbitrate that. Browsers have the Web Locks API for the job —
  the application's page, not this one.

### Identity

One seed (keystore v2), keys by name in its index:

| key        | what it mints                                                    |
| ---------- | ---------------------------------------------------------------- |
| `anchor`   | index 0 — the did:key root; the identity everything hangs off    |
| `mediator` | did:peer:4, no service — the DID the mediator knows this vault by |
| `public`   | did:peer:4 whose service is the mediator's routing DID — what correspondents write to; minted after mediate-grant |
| (later) `contact:<cid>` | one pairwise did:peer:4 per relationship             |

`mintPeerDid(identity, serviceUri)` is deterministic: same seed, index and
service → same DID.

## Usage

```ts
import { createSeedKeystore, unlockSeedKeystore } from "@estoc/keystore";
import { Agent, OpfsBackend, Vault, resolveDid } from "@estoc/agent-core";
import { Message } from "./didcomm-wasm.js"; // your runtime's didcomm-rust glue

const root = await navigator.storage.getDirectory();
const backend = new OpfsBackend(await root.getDirectoryHandle("vaults/alice", { create: true }));

// first run: create
const { doc, seedKey } = await createSeedKeystore(passphrase);
const vault = await Vault.create(backend, {
  label: "Alice",
  keystore: doc,
  seedKey,
  mediatorDid: "did:web:mediator.estoc.dev",
});

// later runs: open, unlock however your app keeps the seed
// const vault = await Vault.open(backend);
// const seedKey = await unlockSeedKeystore(vault.keystore, passphrase);

const agent = new Agent({
  vault,
  seedKey,
  didcomm: { Message },
  events: {
    onStatus: (s) => console.log(s),
    onMessage: (record, view) => render(view),   // view: ChatMessage projection
    onContact: (c) => refreshContacts(),
    onLog: (line) => console.log(line),
  },
});
await agent.start();               // mediate (first time), drain the queue, go live
const history = await agent.history();
await agent.addContact(bobDid, "Bob");
await agent.sendBasicMessage(bobDid, "hello");
```

`Agent` writes to the vault before it tells anyone: log line first, event
second. UIs mirror the vault; they are not the record.

### Didcomm API

The agent takes `{ Message }` from whichever didcomm-rust build your runtime
loads — `didcomm` (browser/workerd WASM, instantiated your way) or
`didcomm-node`. Both export the same `Message` class. This package refuses to
know how the WASM is instantiated, because every bundler and runtime does it
differently.

`didcomm` is a peer dependency for its types only; install the build you
inject.

`fetch`, `WebSocket` and `resolveDid` are injectable too; the tests run two
agents against an in-process fake mediator that way (`test/fake-mediator.ts`).

### What the agent does with the mediator's queue

Every pickup step is safe to repeat. An attachment is acked once it is dealt
with — logged, answered, or ignored on purpose; one that will not open (a
resolver hiccup, a corrupt envelope) is *not* acked, because the mediator's
copy is the only copy, and stays queued for the next start. A drain round
that acks nothing stops the loop instead of fetching the same mail again.
Inbound processing runs one delivery at a time. A socket that closes is
reopened after a pickup, so nothing queued during the outage waits for the
next start.

### Moving a vault: snapshot and import

`snapshotVault(backend)` is the vault's files, byte for byte, keyed by
vault-relative path — the shape a zip holds. `importVault(backend, files)`
lays them down and **merges, never overwrites**: into an empty backend it
is a restore; into a vault of the same identity (same anchor DID) the
snapshot's messages become a new log segment minus what is already here
(same `mid`, or the same wire message received twice), its contacts win by
`updatedAt`, and config and keystore stay local (same seed; mediation is a
fact about this device); a vault of a different identity is refused. How
the files travel — zip, folder, paste — is the application's business.

### Backends

`VaultBackend` is five methods over vault-relative paths: `read`, `write`
(whole-file, atomic), `append`, `remove`, `list`. `MemoryBackend` is the test
double and the shape a zip unpacks into; `OpfsBackend` wraps a
`FileSystemDirectoryHandle` (needs `createWritable()`). A Node `fs` backend
is a page, if a client ever wants one. `test/backend-suite.ts` is the
conformance suite any backend should pass.

## Development

```
npm test        # vitest: backends, vault format, identity, agent × fake mediator
npm run build   # tsc → dist/
```

## License

Apache-2.0
