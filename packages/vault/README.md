# @estoc/vault

What the events of an `.estoc` vault mean. The contract is
[`docs/vault-events.md`](../../docs/vault-events.md) at the repository
root; this package is its reference implementation, and nothing more
than the meaning: no folder, no agent, no protocol, no DID method.

**Version 3 is being built beside this**, under `@estoc/vault/v3`, as
the code form of the
[replica model](../../docs/replica-model/README.md)'s
[vault events](../../docs/replica-model/vault-events.md),
[relationship policy](../../docs/replica-model/relationships.md) and
[distributed delivery](../../docs/replica-model/distributed-delivery.md)
over `@estoc/event-store/v3`. What is there so far is the identifier
vocabulary (`types.ts`: one nominal type per kind of value a payload
names, over the validated string it serializes as), the deterministic
identifiers (`ids.ts`: the six UUIDv5 namespaces derived from the URL
namespace, a relationship from its two birth DIDs sorted by UTF-8 bytes,
its default contact and each end's early private DID, an inbound
observation by the authenticating peer key or the decrypting local key,
an execution from a relationship and a wire ID, an effect key over the
tagged producing tuple and the automatic message ID it names, the
reserved keystore names) and the canonical public-key value
(`public-key.ts`: the did:key encoding of the complete type-tagged key
as base58btc multibase, from a JWK or from its base58btc multibase form,
Ed25519 and X25519 raw, the Weierstrass curves as compressed points that
`@noble/curves` has verified lie on the curve; `@scure/base` does the
base58btc and base64url, `multiformats` the multicodec prefix), the event
schemas (`schema.ts`: `readVaultEvent` / `readVaultDraft` / `vaultDraft`
accept an event of one of the 33 version-3 types — the closed member set
of its payload, each member's type, nullability and spelling, the rules
between members such as a package naming its sender entity's
key-agreement key or an authenticated proof-free receipt keeping its
relationship binding, and the `roots` the type retains — or throw
`InvalidPayload`; what a schema cannot see, whether a referenced event
exists or a JWT verifies, is the folds' and the runtime's, never inferred
here), the stored message document (`document.ts`: `storeMessage`
normalizes a DIDComm `body` and `attachments` into the closed stored
form with its payload objects and roots, `readStoredDocument` reads that
form back, `wireAttachment` puts a descriptor back on the wire only from
a payload of the stored byte count that is, for JSON, already canonical)
and the projections (`projection.ts`: `readPlaintext` takes a plaintext
apart into intent, stored content and addressing, `semanticProjection` /
`intentProjection` / `intentHash` / `plaintextHash` are the hashes the
events carry, `wirePlaintext` is the inverse of `readPlaintext`, and
`expandPleaseAck` / `requestsAck` read `please_ack` without rewriting
it). Every published identifier and public-key vector of those documents
is a test in `test/v3/`.

A version-2 vault is an event log — one append-only log per device,
merged by union — and everything a person sees in it is a *fold* over
the set of events: contacts, channels, messages, my keys and devices,
invitations, deliveries. The store that holds the events, the folder
that serializes them, blobs, local state and interchange are
[`@estoc/event-store`](../event-store/README.md)
([`docs/event-store.md`](../../docs/event-store.md),
[`docs/vault-folder.md`](../../docs/vault-folder.md)); the store knows no
event type. This package is the first layer that does.

```
@estoc/agent-core      the agent: DIDComm, mediation, delivery, the handlers
  ├─ @estoc/vault        what the events mean: types, folds, procedures, keys minted by name   ← this package
  └─ @estoc/event-store  the folder: events in devices/<dev>/<seg>.jsonl, blobs/<cid>, config.json, keystore.json, local/
       └─ VaultBackend   bytes: OpfsBackend (browser) · FsBackend (Node, @estoc/event-store/node) · MemoryBackend (tests)
```

## What is here

- **The event types** (`types.ts`, `docs/vault-events.md` §2–§6): what
  `data` holds under each `type` — `did.minted`, `did.published`,
  `did.registered`, `did.retired`, `mediation.created`,
  `mediation.granted`, `mediation.retired`, `device.minted`,
  `device.label`, `identity.label`, `channel.firstSeen`,
  `peer.resolved`, `peer.rotated`, `message.in`, `message.out`,
  `message.erased`, `delivery.attempted`, `delivery.held`,
  `contact.created`, `contact.attached`, `contact.detached`,
  `contact.merged`, `contact.useKey`, `contact.petname`, `contact.flag`,
  `contact.deleted`, `profile.nameClaimed`, `profile.shared`,
  `extension.installed` / `removed` / `purged` — and `readVaultEvent`,
  which tells a line of one of these types from a line that only claims
  to be (a `Malformed` is kept, never applied). Key names
  (`anchor`, `did/<id>`, `mediation/<id>`) and `channelId` /
  `sameChannel` over a `ChannelKey` live here too.
- **The peer key** (`peerKeyOf`, `fingerprint`, §3): a channel is
  `(my key name, their public key's fingerprint)` —
  `base32lower(sha256(multicodec-prefixed raw public key))[0:26]`, the
  hash of the bytes a `did:key` of that key encodes — so a peer who
  rotates their DID but keeps their key stays the same channel, and one
  who rotates their key is a `peer.rotated` edge between two.
- **The fold** (`VaultFold`, §7): one class over one `EventSet`, with
  `self` (this device) as its one parameter. Pure and order-free: the
  projection is a function of the set, recomputed as each event is
  applied, so events arrive in any order, one at a time, and the result
  is the same (`test/properties.test.ts` shuffles a scene and checks).
  `contacts()`, `contact(cid)`, `deletedContacts()`, `channels()`,
  `channel(pair)`, `attribution(pair)` (channel → `cid`, §7.1),
  `myKeys()`, `myKey(name)`, `devices()`, `label()`, `invitations()`,
  `messages()`, `message(mid)`, `delivery(mid)`, `held()`,
  `erased(mid, root)`, `extensions()`, and `malformed` for what was
  refused. `VaultFold.of(events)` folds a store; `apply(event)` advances
  it.
- **Drafts** (`drafts`): one constructor per type for what `append`
  takes, `blobs` filled in where the type references roots.
- **The procedures** (§8–§10): what a device appends when a person acts,
  each a set of ordinary events decided over the fold and the fold
  advanced as they land. `record` / `recordAll` (append and fold in one
  motion), `recordMessage` (the skeleton with its body and attachments
  put to blobs first), `eraseMessage` and `readRoot` (an absence is
  `erased`, `present` or `missing`, §8.2), `collectBlobs` (the keep-set,
  §8.3), `deleteContact` and `sweepDeleted` (§9), `noteFirstSeen` /
  `notePeerResolved` (channel observations, deduplicated), and
  `holdImported` with `importPolicy()` — the vault's `ImportPolicy` for
  `@estoc/event-store`'s import: an outbound message of another device's
  that arrives without an outcome is held, never sent by this one
  (§10).
- **Keys** (`Keys`, §2, §5) over `@estoc/keystore` v3: one seed, keys
  derived by name, the log the truth about which names exist and
  `keystore.json`'s `keys[]` a cache of it. Every mint appends the event
  that names the key first and writes the cache second (`mintDid`,
  `createMediation`; `rebuildCache` re-derives the cache from the fold).
  What a key is minted *as* is the caller's: a `MintDid` —
  `(identity, serviceUri) => { did, … }`, deterministic — turns a
  derived key and a routing DID into a did:peer:4 (`@estoc/agent-core`)
  or anything with a `did` (a test); `verifyAnchor` checks the recorded
  anchor DID against the seed rather than trusting the file.
- **The folder, opened for an identity** (`createFolderVault`,
  `openFolderVault`): `@estoc/event-store`'s `FolderVault` plus the
  anchor fixed in `config.json` at creation, the seed checked against it
  on every open, `Keys` beside it, and the fold over every device's
  events — the application's first read. Returns
  `{ vault, keys, fold, anchor }`. A version-1 folder, or any folder that
  is not a vault, is refused with `NotAVault`; there is nothing to
  migrate.

## Usage

```ts
import { createSeedKeystore } from "@estoc/keystore";
import { MemoryBackend } from "@estoc/event-store";
import { createFolderVault, drafts, record, type MintDid } from "@estoc/vault";

const mint: MintDid = (identity, service) => ({ did: /* your DID method over identity + service */ });
const { doc, seedKey } = await createSeedKeystore(passphrase);
const { vault, keys, fold } = await createFolderVault(new MemoryBackend(), doc, seedKey, { mint });

await record(vault.events, fold, drafts.identityLabel({ name: "Alice" }));
const { event, key } = await keys.mintDid(fold, null);   // did.minted, key did/<id>
fold.myKeys();                                             // [{ name: "anchor", … }, { name: key, … }]
```

To open the same folder later: `openFolderVault(backend, seedKey, { mint })`.
With did:peer:4 and a mediator, use `openVault` / `createVault` from
`@estoc/agent-core`, which binds `mint` and adds the agent on top.

## Development

```
pnpm test       # vitest: types, the fold and its properties, procedures, identity
pnpm build      # tsc → dist/
```

## License

Apache-2.0
