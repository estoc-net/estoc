# @estoc/vault

The `.estoc` vault format as code. The contract is
[`docs/vault-format.md`](../../docs/vault-format.md) at the repository
root; this package is its reference implementation, and nothing more than
the format: no agent, no protocol, no DID method.

A vault is a directory, and the directory **is** the format: a backup is
the directory zipped, a second device is the directory copied. This
package holds the bytes through a pluggable `VaultBackend`, reads and
writes the layout over it, and moves vaults around (snapshot, merge
import). Runs in the browser (OPFS), Node (a folder on disk), and tests
(memory).

```
.estoc/
  config.json            singleton: label, identity anchor, mediation snapshot
  keystore.json          singleton: @estoc/keystore v3 — one sealed seed + a plaintext cache of key names
  contacts/<cid>.json    record: one mutable file per contact, DID history with evidence
  invitations/<id>.json  record: single-use invitations issued, a DID waiting for whoever answers first
  messages/<uuidv7>.jsonl    log: append-only; segments named by uuidv7, read in name order
  deliveries/<uuidv7>.jsonl  log: what became of each outbound message: sent / failed / held, per try
  blobs/<hash>           content-addressed bytes (attachments, shared objects)
  state/ cache/          reserved (per-person state · rebuildable, never snapshotted)
```

## What is here

- **`Vault`** — the directory as an object: the two singletons in memory
  (`config`, `keystore`), the stores over the records and logs
  (`contacts`, `invitations`, `messages`, `deliveries`, `blobs`), and the
  keys by name (`derive`, `mintKey`, `verifyAnchor`). `Vault.create` lays
  down the anchor; `setMediator`, `mintPairwise`, `createInvitation` and
  `peerIdentity` do the bookkeeping the contract asks for around a DID —
  the key name, the record written before the cache entry, the retired
  public DID kept for the unanswered.
- **Key names are derivation paths.** The seed and a name give the key
  (`@estoc/keystore` v3: `estoc/v3/<purpose>/<name>`), so `keystore.json`'s
  key list is a cache and the records are the truth: every mint writes
  the record naming the key (config, a contact's `myDids[]`, an
  invitation) before the cache entry, and a name the cache never heard
  of derives all the same. No name is a counter and none is reused:
  `anchor`, `mediation/<id>/me|public` by the mediation's uuidv7,
  `pair/<cid>/<uuidv7>`, `invite/<id>`.
- **DIDs are snapshots**, recorded when minted and checked against the
  seed rather than recomputed: the anchor by `verifyAnchor`, every other
  ref by `peerIdentity`. Rotating a mediator later never silently renames
  an identity.
- **What a DID is, is not the format's to say.** `Vault` takes a `MintDid`
  when opened — `(identity, serviceUri) => { did, … }` — and records what
  it returns. `@estoc/agent-core` binds it to did:peer:4 with the
  mediator's routing DID as the service (`openVault`, `createVault`
  there); a test binds it to a name. The minter must be deterministic:
  that is how the recorded DIDs are checked against the seed.
- **Contacts** are keyed by `cid` (uuidv7). Their DIDs form a history
  (`dids[]`, closed with `until`, hops proven by `fromPrior`), and so do
  ours toward them (`myDids[]`: the keystore `key` that derives each,
  `registeredAt` once a mediator accepts it). `addressedAs` is the DID of
  ours their latest envelope was sealed to. The file is named by `cid`,
  so a record has one home for life; `updatedAt`, stamped on every
  write, is what a merge compares.
- **Logs** (`SegmentedLog`) are append-only JSONL in segments named by
  uuidv7: readers take every segment in name order, skip a damaged or
  cut-short line and report it, and a later session appends behind the
  newest segment. The message log stores `{mid, at, direction, sender?,
  msg}`; the delivery log stores what became of each outbound message.

### Moving a vault: snapshot and import

`snapshotVault(backend)` is every file under `.estoc/` except `cache/`,
byte for byte, keyed by vault-relative path — the shape a zip holds, and
not an allowlist: what another client wrote travels too.
`importVault(backend, files)` lays them down and **merges, never
overwrites**: into an empty backend it is a restore; into a vault of the
same identity (same anchor DID) the snapshot's messages become a new log
segment minus what is already here (same `mid`, or the same wire message
received twice), its delivery events likewise (minus tries already here;
a `held` is one device's own and does not travel), its contacts win by
`updatedAt`, its invitations are added when missing (and marked taken
when the snapshot saw the answer — only `acceptedBy`/`acceptedAt` cross
over; `registeredAt` is this device's own), its config stays local
(mediation is a fact about this device), its keystore's key cache is
unioned by name over this device's sealed seed, and any other path is
copied when absent and never overwritten; a vault of a different identity
is refused. Either way, an outbound message that arrives undelivered is
held for a retry by hand (`held` in the outcome). How the files travel —
zip, folder, paste — is the application's business.

### Backends

`VaultBackend` is six methods over vault-relative paths: `read`, `write`
(whole-file, atomic), `append`, `remove`, `list` (files), `dirs`
(subdirectories); `walk(backend, dir)` builds the recursive view a
snapshot takes.

- `MemoryBackend` — the test double and the shape a zip unpacks into.
- `OpfsBackend` — wraps a `FileSystemDirectoryHandle` (needs
  `createWritable()`).
- `FsBackend` (`@estoc/vault/node`) — a folder on disk: whole-file writes
  go to a sibling temp file and are renamed into place, a replaced file
  keeps its mode, appends are `appendFile`.

`test/backend-suite.ts` is the conformance suite any backend should pass.

## Usage

```ts
import { createSeedKeystore } from "@estoc/keystore";
import { MemoryBackend, Vault, type MintDid } from "@estoc/vault";

const mint: MintDid = (identity, service) => ({ did: /* your DID method over identity + service */ });
const { doc, seedKey } = await createSeedKeystore(passphrase);
const vault = await Vault.create(new MemoryBackend(), { label: "Alice", keystore: doc, seedKey, mint });
await vault.contacts.put(newContact("Bob", bobDid));
const records = await vault.messages.read();
```

With did:peer:4, use `openVault` / `createVault` from `@estoc/agent-core`.

## Development

```
pnpm test       # vitest: backends (memory, fs), vault format, snapshot + import
pnpm build      # tsc → dist/
```

## License

Apache-2.0
