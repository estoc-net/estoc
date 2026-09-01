# @estoc/agent-core

The DIDComm v2 agent behind Estoc's clients: mediation (coordinate-mediation
3.0), pickup and live delivery (messagepickup 3.0 over HTTP and WebSocket),
routing 2.0 forwards packed by hand, layer by layer, pairwise DIDs rotated
by `from_prior`, invitations, user-profile/1.0 introductions and
object-share/1.0 — all over an `.estoc` vault (`@estoc/event-store` for the
folder, `@estoc/vault` for what its events mean) stored through a pluggable
backend.

Runs wherever didcomm-rust's WASM does: the browser (Vite), workerd, Node.
The WASM itself is *not* loaded here — see [Didcomm API](#didcomm-api).

## Layers

```
Agent            every module below under one running loop: start · setMediator · send · the socket · the trace
  ├─ identity    did:peer:4 from a seed-derived key (@estoc/keystore v3), bound to the folder: openVault · createVault · inspectVault
  ├─ records     what a caller reads: MessageRecord (plaintext read back from blobs), ContactRecord (with a name), InvitationRecord
  ├─ keyring     the keys of ours this device holds, derived by name and checked against the DIDs the log recorded
  ├─ channel     the channel an envelope proves: from the key that opened it and the key that sealed it, the pair
  ├─ link        the line to the mediator: sealing to it, opening what it sends, HTTP and the socket, traced
  ├─ mediation   the rituals over the link: grant, register, leave, rotate — each decided over the fold, safe to repeat
  ├─ pickup      the mail the mediator holds for us, fetched and acknowledged; live delivery down the socket
  ├─ inbound     one opened envelope → the events it leaves and the answer it gets
  ├─ outbound    a message of ours → composed, recorded, sealed, forwarded, posted; the outbox it waits in
  ├─ share       object-share/1.0, the giving side: the package road past maxShareBytes
  ├─ handlers/   basicmessage 2.0 · user-profile 1.0 · object-share 1.0, through the handler seam (handler.ts)
  ├─ trace       what this device observed, in local/agent/trace/<stream>/ — never a fact of the vault
  ├─ protocol/   the protocols as the specifications have them: spec (forward, ping, oob, from_prior), mediation,
  │              didcomm helpers, resolver (did:web + did:peer), mediator input, object-share's wire format and checks,
  │              streaming AEAD, blob-store — nothing here reads a vault
  ├─ @estoc/vault (v2)   what the events mean: the fold — contacts, channels, messages, my keys, invitations, deliveries
  └─ @estoc/event-store  the folder: events in devices/<dev>/<seg>.jsonl, blobs/<cid>, config.json, keystore.json, local/
       └─ VaultBackend   bytes: OpfsBackend (browser) · FsBackend (Node, @estoc/event-store/node) · MemoryBackend (tests)
```

### Three kinds of protocol

- **Specification protocols** (`protocol/spec.ts`) are the agent's own:
  how an envelope is forwarded, how a `from_prior` rotation is verified,
  how an invitation is claimed, how a ping is answered. They are not
  registrable — an application cannot swap them out.
- **Mediation and pickup** (`protocol/mediation.ts`, `mediation.ts`,
  `pickup.ts`) are community protocols the agent uses as its transport.
  That traffic runs between the agent and its mediator, not between the
  user and a contact, and a delivery is only an envelope around the real
  mail — none of it is a message record. What the agent settles with its
  mediator is recorded as events of its own (`mediation.granted`,
  `did.registered`, `did.retired`, `mediation.retired`); the plaintext of
  the rituals goes to the trace.
- **Application protocols** (`handler.ts`) are everything between the
  user and a contact. The agent's part is fixed and the same for every
  type — open, prove the sender, record, home to a contact, `onMessage` —
  and a `ProtocolHandler` adds behaviour on top, looked up by type after
  the record is in the log: `onInbound` to answer, `introduce` to say
  something before the first message to anyone. A handler reads the fold
  and records events; it holds no vault and saves no contact. basicmessage/2.0,
  user-profile/1.0 and object-share/1.0 are built-in handlers;
  `AgentOptions.handlers` adds more (or replaces a built-in for a type).
  A message of a type nobody handles is still recorded, still handed to
  `onMessage` — the application decides what to make of it.

**Everything between contacts is recorded, whatever its type** — chat,
profiles, pings, a protocol nobody here speaks. Whether it shows is the
application's projection of the fold, not the agent's decision.

### The vault, and the DIDs in it

The contract is in three documents at the repository root:
[`docs/event-store.md`](../../docs/event-store.md) (the event model and
the store interfaces), [`docs/vault-folder.md`](../../docs/vault-folder.md)
(the `.estoc` folder) and [`docs/vault-events.md`](../../docs/vault-events.md)
(the event types and the fold). [`@estoc/event-store`](../event-store/README.md)
implements the first two, [`@estoc/vault`](../vault/README.md) the third,
and neither knows what a DID is — the format records what a `MintDid`
returns. This package binds it to did:peer:4 (`openVault`, `createVault`:
`openFolderVault`/`createFolderVault` with `mintPeerDid`) — Multikey long
form, one Ed25519 and one X25519 key, the mediator's routing DID as the
service when there is one. `inspectVault` is the step before the seed is
in hand: the folder opened (a version-1 folder, or none, is `NotAVault`)
and the sealed keystore read, so a passphrase can be asked for.

What matters to the agent:

- **The vault is the record and the fold its reading.** Everything the
  agent learns is an event in the log before anyone is told; the state
  the v1 agent carried — records saved, caches loaded at start — is the
  fold now, read fresh at every step. UIs mirror the vault; they are not
  the record. Every decision is the fold's to explain afterwards.
- **Keys and DIDs** (vault-events.md §2, §5). One seed (keystore v3); every
  key is derived from it by name — `anchor` (the did:key root, the one
  fixed name), `did/<id>` for every did:peer:4 minted, the `me` of every
  mediation. A DID is a name a key wears: the log records what was minted
  (`did.minted`), published, registered with a mediator, retired; the
  keyring derives each from its name and checks it against the DID the
  log recorded. `mintPeerDid(identity, serviceUri)` is deterministic —
  same seed, name and service, same DID.
- **Channels, not conversations** (§3). The unit of attribution is the
  pair *(the key of ours that opened the envelope, the peer's key that
  sealed it)*, proven by the envelope and never by the plaintext `from`.
  What a device sees on a channel first — the peer's document, a
  `from_prior` — it records (`channel.firstSeen`, `peer.resolved`,
  `peer.rotated`); which contact a channel belongs to is the fold's answer
  (§7.1). Anonymous mail is recorded, belongs to no contact, and reaches
  no handler.
- **Messages** (§3.1, §4). A message is a skeleton event on its channel
  (`message.in` / `message.out`: direction, the DID proved, the roots of
  its body and attachments) and its plaintext a block in `blobs/`, written
  body first. A `MessageRecord` is the two read together, with a `body`
  state for a plaintext that is erased or missing (§8.2). The same wire id
  from the same key again is a duplicate, dropped.
- **Sending** (§3.1, §7.2). `send` records the `message.out` first and
  only then tries to deliver it; every try is a `delivery.attempted` event
  on the message's channel, never a change to the message. The **outbox**
  is a reading of the fold — every `message.out` not yet sent — tried in
  order per contact at every start, when the mediator's socket comes
  back, ahead of the next message to the same contact, on `agent.flush()`
  and by hand through `agent.retry(mid)`. A message an import brought in
  undelivered is *held*: left alone unless named. `onDelivery` reports
  where each one stands.
- **Contacts** (§6, §7.2) are a component of events, not a record saved:
  a contact is what attaches to it (`contact.attached`, `contact.useKey`,
  a petname, what a peer called themself on a channel). A `ContactRecord`
  is the fold's contact with the name it is shown by (`nameOf`: the
  petname, else what they claimed, else a stand-in for their DID). A
  stranger's first message makes them a contact unless `adoptStrangers`
  is off.
- **Pairwise DIDs, rotation by `from_prior`.** The public DID is a business
  card; the first message we send anyone goes out from a did:peer:4 minted
  for that relationship (`contact.useKey`). A contact who wrote to the
  public DID first is told about the move the DIDComm way — `from_prior`
  on every message out until a reply comes back addressed to the new DID
  (`addressedAs`, a fold). Inbound, a verified `from_prior` moves the
  contact's key to the new DID (`peer.rotated`, the message as evidence).
  Every key we ever minted stays openable, so mail to a retired one is
  not lost.
- **The mediator is not part of the identity** (§5). A vault is created
  from a seed and a label alone; `Agent.setMediator(did)` records the
  arrangement and brings it up: mediate-grant, the DID the mediator knows
  us by, the public DID whose service is its routing DID, every address
  of ours registered. Changing mediator is a rotation of every DID that
  rode the old route (`rotateStale`), never a silent rename; each contact
  we introduced ourselves to is pinged from the new DID with `from_prior`
  attached. Every ritual is decided over the fold and safe to repeat, so
  a move cut short by a crash finishes at the next start.
- **Invitations** (§7.4). `Agent.createInvitation(goal?)` mints a
  did:peer:4 for nobody yet, publishes it, and `invitationUrl(base,
  agent.invitationMessage(record))` makes the out-of-band/2.0 URL to hand
  over (every Estoc client reads only `_oob`). `acceptInvitation(url,
  name)` on the other side adds the contact by the DID inside and
  introduces itself from a DID minted for them, naming the invitation as
  `pthid`. The first envelope sealed to an invitation's key takes it; a
  second taker is turned away. `revokeInvitation` withdraws an open one.
- **Devices** (§7.3). Another device's keys are seen in the fold and left
  alone: not registered under this device's mediation, not retired for
  riding a route that is not ours. What this device does with the
  mediator is this device's; a merge brings the rest.
- **At rest, the vault is plaintext** apart from the seed. An application
  wanting encryption at rest wraps the backend.
- **One agent per vault at a time.** Two agents (two tabs) on one vault
  would append to the same device log; the package does not arbitrate
  that. Browsers have the Web Locks API for the job — the application's
  page, not this one.

## Usage

```ts
import { createSeedKeystore, unlockSeedKeystore } from "@estoc/keystore";
import { OpfsBackend } from "@estoc/event-store";
import { Agent, createVault, inspectVault, invitationUrl, openVault } from "@estoc/agent-core";
import { FromPrior, Message } from "./didcomm-wasm.js"; // your runtime's didcomm-rust glue

const backend = new OpfsBackend(await navigator.storage.getDirectory());

// first run: create — an identity needs no mediator to exist
const { doc, seedKey } = await createSeedKeystore(passphrase);
const vault = await createVault(backend, { keystore: doc, seedKey, label: "Alice" });

// later runs: inspect (the sealed keystore, nothing derived), unlock, open
// const { keystore } = await inspectVault(backend);
// const seedKey = await unlockSeedKeystore(keystore, passphrase);
// const vault = await openVault(backend, seedKey);   // the seed checked against the anchor

const agent = new Agent({
  vault,
  didcomm: { Message, FromPrior },
  events: {
    onStatus: (s) => console.log(s),
    onMessage: (record, contact) => render(record, contact), // the record + the contact its channel belongs to (or null)
    onDelivery: (delivery, record) => mark(record, delivery), // a try at delivering one of ours ended; the fold says where it stands
    onContact: (c) => refreshContacts(),
    onInvitation: (i) => refreshInvitations(),
    onLog: (line) => console.log(line),
  },
});
await agent.start();               // no mediator yet → status "unmediated"; the fold still reads
await agent.setMediator("did:web:mediator.estoc.dev"); // mediate, mint the public DID, go live — or, later, move to another
// later starts on this vault mediate straight away
const contacts = vault.fold.contacts();          // the facts; what they look like on screen is yours to decide
await agent.addContact(bobDid, "Bob");
const record = await agent.sendBasicMessage(bobDid, "hello"); // = agent.send(bobDid, BASIC_MESSAGE, { content: "hello" }); recorded first, then delivered — offline it waits in the outbox
await agent.retry(record.mid);                                // try one waiting message again by hand (a held one, or a failed one now)
await agent.send(bobDid, "https://example.org/poll/1.0/question", { q: "lunch?" }, { thid }); // any protocol

// an application protocol of your own: the agent records and homes the message; you answer inside it
new Agent({ ..., handlers: [{
  types: ["https://example.org/poll/1.0/question"],
  async onInbound(record, contact, ctx) {
    await ctx.reply(contact, "https://example.org/poll/1.0/vote", { choice: "rice" }, { thid: record.msg.id });
  },
}] });

// or meet without a public DID changing hands: one side issues, the other accepts
const invitation = await agent.createInvitation("Write to Alice");
const url = invitationUrl(location.origin, agent.invitationMessage(invitation));
// … Bob, given the URL:
await bobAgent.acceptInvitation(url, "Alice");               // adds her, introduces himself
```

### Didcomm API

The agent takes `{ Message, FromPrior }` from whichever didcomm-rust build
your runtime loads — `didcomm` (browser/workerd WASM, instantiated your way)
or `didcomm-node`. Both export the same classes. This package refuses to
know how the WASM is instantiated, because every bundler and runtime does it
differently.

`didcomm` is a peer dependency for its types only; install the build you
inject.

`fetch`, `WebSocket` and `resolveDid` are injectable too; the tests run two
agents against an in-process fake mediator that way (`test/fake-mediator.ts`).

### What the agent does with the mediator's queue

Every pickup step is safe to repeat. An attachment is acked once it is dealt
with — recorded, a duplicate, or ignored on purpose; one that will not open
(a resolver hiccup, a corrupt envelope) or that a step threw on is *not*
acked, because the mediator's copy is the only copy, and stays queued for
the next pickup. Every event a message gives rise to is in the log before
its record is, so a crash between two steps leaves a log the redelivery
finishes, each step finding its own work done. Inbound processing runs
one delivery at a time, whichever way it came. A socket that closes is
reopened after a pickup, so nothing queued during the outage waits for the
next start.

### Objects

`agent.shareObject(did, object, { sign?, card? })` shares a folder-object
(`docs/object-share.md`): the closure goes inline when it fits
`maxShareBytes`; otherwise the skeleton goes inline and the whole closure
as one encrypted CAR put at our mediator's blob store — a package the
share names by URL, hash and key, which the receiving application fetches
with `agent.fetchPackage(record)` (`packageFetch` is the fetch that does
it: a host that can reach a private network passes one that refuses
non-public addresses). A received share is checked and its blocks kept as
the message is recorded (`keepShare`); the skeleton's `attachments` name
the root of a share that verified, and nothing of one that did not.

### The trace

Everything the agent observes on its way to and from the log goes to the
trace (`AgentTrace`, in the vault's `local/agent/trace/<stream>/`:
vault-folder.md §7) — never a fact of the vault, never in a backup. The
streams: the frames it sends and receives (`wire`: via, endpoint, size,
HTTP status, duration; `wire.bytes`: the ciphertext), every envelope
sealed or opened (`envelope`: kind, algorithms, key ids, the message type
— no plaintext), the plaintext of its rituals with mediators
(`mediation`), and what `onLog` was told (`diag`). Each line names the
observation it happened inside (`parent`), and an envelope that ended in
a record names it (`mid`) — `agent.traceOf(mid)` is the whole onion of
one message, outermost frame to innermost seal, written only after the
record is. What is kept and for how long is a device option
(`agent.traceLevel()` / `setTraceLevel`: `off`, `normal`, `verbose`, in
`local/agent/options.json`); the agent prunes whole segments at every
start and hourly, and a trace that cannot be written is said on the log,
never a reason to stop moving mail.

### Moving a vault, and backends

Snapshot, export, import and restore, and the `VaultBackend`s
(`MemoryBackend`, `OpfsBackend`, `FsBackend` in `@estoc/event-store/node`)
live in `@estoc/event-store`; what an import means for the fold — a
message another device sent, held; a contact merged — is `@estoc/vault`'s
(`holdImported`, `importPolicy`). The agent restarts on a merged vault
and reads the fold afresh.

## Development

```
pnpm test       # vitest: identity, records, keyring, channel, link, mediation, pickup, inbound, outbound, share, handlers, trace, streaming AEAD, and the agent × a fake mediator
pnpm build      # tsc → dist/
```

## License

Apache-2.0
