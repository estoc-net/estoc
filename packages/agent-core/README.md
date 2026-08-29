# @estoc/agent-core

The DIDComm v2 agent behind Estoc's clients: mediation (coordinate-mediation
3.0), pickup and live delivery (messagepickup 3.0 over HTTP and WebSocket),
routing 2.0 forwards packed by hand, layer by layer, and user-profile/1.0
introductions, all over an `.estoc` vault (`@estoc/vault`) stored through
a pluggable backend.

Runs wherever didcomm-rust's WASM does: the browser (Vite), workerd, Node.
The WASM itself is *not* loaded here — see [Didcomm API](#didcomm-api).

## Layers

```
Agent                        envelopes · attribution · the log · mediation · pickup · live delivery
  ├─ protocol/spec           what the DIDComm v2 spec defines: routing (forward), trust-ping, out-of-band, from_prior — wired into Agent
  ├─ protocol/mediation      coordinate-mediation 3.0 · messagepickup 3.0 — transport with the mediator, never logged
  ├─ protocol/handler        the seam for application protocols; basicmessage 2.0 and user-profile 1.0 ship as handlers
  ├─ protocol/               resolver (did:web + did:peer), mediator input, out-of-band helpers
  ├─ identity/               did:peer:4 from a seed-derived identity (@estoc/keystore v3), bound to the vault (openVault, createVault)
  └─ @estoc/vault            the .estoc format: config · keystore · contacts · invitations · message log · delivery log
       └─ VaultBackend       bytes: OpfsBackend (browser) · FsBackend (Node) · MemoryBackend (tests, snapshots)
```

### Three kinds of protocol

- **Specification protocols** (`protocol/spec.ts`) are the agent's own:
  how an envelope is forwarded, how a `from_prior` rotation is verified,
  how an invitation is claimed, how a ping is answered. They are not
  registrable — an application cannot swap them out.
- **Mediation and pickup** (`protocol/mediation.ts`) are community
  protocols the agent uses as its transport. That traffic runs between
  the agent and its mediator, not between the user and a contact, and a
  delivery is only an envelope around the real mail — none of it enters
  the log.
- **Application protocols** (`protocol/handler.ts`) are everything between
  the user and a contact. The agent's part is fixed and the same for every
  type — open, attribute, log, home to a contact, `onMessage` — and a
  `ProtocolHandler` adds behaviour on top, looked up by type after the
  record is in the log: `onInbound` to answer or update a contact,
  `introduce` to say something before the first message to anyone.
  `basicmessage/2.0` and `user-profile/1.0` are built-in handlers;
  `AgentOptions.handlers` adds more (or replaces a built-in for a type).
  A message of a type nobody handles is still logged, still handed to
  `onMessage` — the application decides what to make of it.

**Everything between contacts is logged, whatever its type** — chat,
profiles, pings, a protocol nobody here speaks. Whether it shows is the
application's projection of the log, not the agent's decision.

### The vault, and the DIDs in it

The contract is [`docs/vault-format.md`](../../docs/vault-format.md) at
the repository root; [`@estoc/vault`](../vault/README.md) is its
reference implementation, and the format package does not know what a
DID is — it records what a `MintDid` returns. This package binds it to
did:peer:4 (`openVault`, `createVault`: `Vault.open`/`Vault.create` with
`mintPeerDid`) — Multikey long form, one Ed25519 and one X25519 key, the
mediator's routing DID as the service when there is one.

The layout, key naming, contacts, logs, snapshot and import, and the
backends are documented there. What matters to the agent:

- **DIDs in config are snapshots**, recorded when minted, and checked against
  the seed rather than recomputed: the anchor first, at every start
  (`Vault.verifyAnchor` — a seed that does not derive it is the wrong
  keystore for this vault), every other ref as it comes into use
  (`Vault.peerIdentity`). Rotating a mediator later never silently renames
  an identity.
- **The mediator is not part of the identity.** A vault is created from a
  seed and a name alone (`mediation: null`); `Vault.setMediator` names a
  mediator later and mints the DID it will know the vault by. The public
  DID embeds the mediator's routing DID, so choosing one is a decision
  about reachability, taken after the identity exists — and changing it
  is a rotation of every DID that named the old one, never a silent
  rename (see *Changing mediator* below).
- **Contacts** are keyed by `cid` (uuidv7). Their DIDs form a history
  (`dids[]`, closed with `until`, hops proven by `fromPrior`), and so do
  ours toward them (`myDids[]`: the keystore `key` that derives each, and
  `registeredAt` once the mediator accepts it). `addressedAs` is the DID
  of ours their latest envelope was sealed to — what decides whether the
  next message out needs `from_prior`. The file is named by `cid`, so a
  record has one home for life; the petname lives inside it, and
  `updatedAt`, stamped on every write, is what a merge compares.
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
  serialised per `MessageLog` instance. (`SegmentedLog` is the shared
  shape; the delivery log is another instance of it.)
- **The delivery log** is where sending lives. `send` appends the record
  first and only then tries to deliver it; the outcome of every try is an
  event `{mid, at, status: sent | failed | held, attempt, to?, error?}` in
  `deliveries/`, never a change to the message line. `foldDeliveries`
  turns the events into one state per `mid` (newest wins, `sent` is
  final); an outbound record with no event is *pending*. What is not
  sent is the **outbox**: tried again at every start, when the mediator's
  socket comes back, and ahead of the next message to the same contact —
  in order per contact, stopping at that contact's first failure so a
  conversation never arrives shuffled — on `agent.flush()` when the
  application learns the network is back, and by hand through
  `agent.retry(mid)`. The wire `id` never changes across tries, so a try
  that reached the far side unnoticed is dropped there as a duplicate.
  A record an import brings in undelivered is `held`: not tried unasked
  (a backup is a move, not a sync), retried by hand only. `onDelivery`
  reports every event.
- **Attribution is the envelope's.** Inbound mail is attributed to the DID
  the authcrypt layer proves, never to the plaintext `from` (which anyone
  can type into an anonymous envelope). Anonymous mail is logged with
  `sender: null`, belongs to no contact (`counterpartyOf` yields null, and
  `onMessage` hands it over with no contact), cannot rename a contact,
  and reaches no handler — there is nobody to answer.
- **Pairwise DIDs, rotation by `from_prior`.** The public DID is a business
  card: strangers write to it. The first message we send anyone goes out
  from a did:peer:4 minted for that relationship (`pair/<cid>/<uuidv7>`, service
  = the mediator's routing DID, registered with the mediator as a
  recipient on the first delivery from it, or at the next start). A
  contact who wrote to the public DID first is told about the move the
  DIDComm way — every message out carries
  `from_prior`, a JWT the DID they know signs over the one we now use,
  until a reply comes back addressed to the new DID (a contact who never
  wrote to us is taken to know the public DID, so a first message vouches
  for its fresh DID with it, and their side can tie the two). Inbound, a
  `from_prior` didcomm-rust verified moves the contact its issuer names to
  the new DID (old one closed, JWT kept as evidence) — provided the
  envelope was sealed by that new DID. Every DID we ever minted stays
  openable, so mail to a retired one is not lost. What pairwise hides is
  the link *between* your contacts; the mediator still sees every
  recipient DID under one account.
- **Changing mediator.** `Agent.setMediator(did)` on a vault that has one
  moves it: the old mediator is asked to drop every DID it knew us by, open
  invitations are withdrawn (their DIDs led there), the vault records the
  move (`Vault.setMediator`: a fresh mediation id and mediator-facing key, `mediation/<id>/me`,
  and — for every contact who wrote to the public DID and was never
  answered — that public DID as the closed first entry of their `myDids[]`,
  the prior a later reply will name), and the agent starts against the new
  one: mediate-grant, a new public DID under `mediation/<id>/public`, and then the
  invariant every start checks — every current DID toward a contact rides
  the current routing DID; one that does not is closed for a fresh one —
  so a move cut short by a crash finishes at the next start. Each contact
  we have introduced ourselves to is then sent a trust-ping (2.0, no
  response asked) from the new DID with `from_prior` attached, so they
  move at once instead of at our next message; the same `from_prior` rides
  on that message anyway. Retired keys stay in the keystore, and their
  DIDs stay derivable, because a retired public DID may still have to sign
  a `from_prior` for someone who only ever wrote to it. What no rotation
  can carry: a business card already handed out names the old mediator,
  and a stranger who only has the card cannot follow — the old mediator
  bounces them (a contact who knows us finds us by it: their record's DID
  history includes it).
- **Invitations.** The third way to meet, and the only one where nothing
  public changes hands: `Agent.createInvitation()` mints a did:peer:4 for
  nobody yet (`invite/<id>`, registered with the mediator), records it
  under `invitations/<id>.json`, and `invitationUrl(base, message)` makes
  the out-of-band/2.0 URL to hand over (`goal_code: connect`, `goal` in
  words; the host is whatever app should open it — every Estoc client
  reads only `_oob`). `Agent.acceptInvitation(urlOrOob, petname)` on the
  other side adds the contact by the DID inside and introduces itself at
  once from a DID minted for them, naming the invitation as `pthid`. The
  first envelope sealed to an invitation's DID takes it: that DID becomes
  ours toward the sender (moved into their `myDids[]`), the invitation is
  marked `acceptedBy`, and anyone else writing to it afterwards is turned
  away. Neither side owes a `from_prior`, because neither ever knew the
  other by a public DID. `revokeInvitation` withdraws an open one.
- **At rest, the vault is plaintext** apart from the seed: messages and
  contacts are readable files. An application wanting encryption at rest
  wraps the backend.
- **One agent per vault at a time.** Two agents (two tabs) on one vault
  would append to the same log and rewrite the same config; the package
  does not arbitrate that. Browsers have the Web Locks API for the job —
  the application's page, not this one.

### Identity

One seed (keystore v3); every key is derived from it by name, and the
name is the id of the thing the key belongs to:

| key        | what it mints                                                    |
| ---------- | ---------------------------------------------------------------- |
| `anchor`   | the did:key root; the identity everything hangs off (the one fixed name — the seed alone recovers it) |
| `mediation/<id>/me` | did:peer:4, no service — the DID the mediator knows this vault by; `id` is the mediation's uuidv7 (`config.mediation.id`), minted by `setMediator` — fresh on every change of mediator |
| `mediation/<id>/public` | did:peer:4 whose service is the mediator's routing DID — the address for strangers; minted after mediate-grant, under the same id |
| `pair/<cid>/<uuidv7>` | a pairwise did:peer:4 toward contact `cid`, same shape as `public`; one uuid per DID minted toward them, recorded in the contact's `myDids[]` |
| `invite/<id>` | the did:peer:4 an invitation hands out, same shape; once taken it is the key behind that contact's `myDids[]` entry, name unchanged |

`mintPeerDid(identity, serviceUri)` is deterministic: same seed, name and
service → same DID.

## Usage

```ts
import { createSeedKeystore, unlockSeedKeystore } from "@estoc/keystore";
import { OpfsBackend } from "@estoc/vault";
import { Agent, createVault, openVault, resolveDid } from "@estoc/agent-core";
import { FromPrior, Message } from "./didcomm-wasm.js"; // your runtime's didcomm-rust glue

const root = await navigator.storage.getDirectory();
const backend = new OpfsBackend(await root.getDirectoryHandle("vaults/alice", { create: true }));

// first run: create — an identity needs no mediator to exist
const { doc, seedKey } = await createSeedKeystore(passphrase);
const vault = await createVault(backend, { label: "Alice", keystore: doc, seedKey });

// later runs: open, unlock however your app keeps the seed
// const vault = await openVault(backend);
// const seedKey = await unlockSeedKeystore(vault.keystore, passphrase);

const agent = new Agent({
  vault,
  seedKey,
  didcomm: { Message, FromPrior },
  events: {
    onStatus: (s) => console.log(s),
    onMessage: (record, contact) => render(record, contact), // the log record + the contact it is homed to (or null)
    onDelivery: (event, record) => mark(record, event.status), // a try at delivering one of ours ended: sent, or failed with a reason
    onContact: (c) => refreshContacts(),
    onInvitation: (i) => refreshInvitations(),
    onLog: (line) => console.log(line),
  },
});
await agent.start();               // no mediator yet → status "unmediated"; the log still reads
await agent.setMediator("did:web:mediator.estoc.dev"); // mediate, mint the public DID, go live — or, later, move to another
// later starts on this vault mediate straight away (or pass mediatorDid to createVault)
const records = await vault.messages.read();   // the facts; what a record looks like on screen is yours to decide
await agent.addContact(bobDid, "Bob");
await agent.sendBasicMessage(bobDid, "hello");                 // = agent.send(bobDid, BASIC_MESSAGE, { content: "hello" }); logged first, then delivered — offline it waits in the outbox
await agent.retry(mid);                                        // try one waiting message again by hand (a held one, or a failed one now)
await agent.send(bobDid, "https://example.org/poll/1.0/question", { q: "lunch?" }, { thid }); // any protocol

// an application protocol of your own: the agent logs and homes the message; you answer inside it
new Agent({ ..., handlers: [{
  types: ["https://example.org/poll/1.0/question"],
  async onInbound(record, contact, agent) {
    await agent.reply(contact, "https://example.org/poll/1.0/vote", { choice: "rice" }, { thid: record.msg.id });
  },
}] });

// or meet without a public DID changing hands: one side issues, the other accepts
const invitation = await agent.createInvitation();          // "Write to Alice"
const url = invitationUrl(location.origin, agent.invitationMessage(invitation));
// … Bob, given the URL:
await bobAgent.acceptInvitation(url, "Alice");               // adds her, introduces himself
```

`Agent` writes to the vault before it tells anyone: log line first, event
second. UIs mirror the vault; they are not the record.

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
with — logged, answered, or ignored on purpose; one that will not open (a
resolver hiccup, a corrupt envelope) is *not* acked, because the mediator's
copy is the only copy, and stays queued for the next start. A drain round
that acks nothing stops the loop instead of fetching the same mail again.
Inbound processing runs one delivery at a time. A socket that closes is
reopened after a pickup, so nothing queued during the outage waits for the
next start.

### The trace

Everything the agent observes on its way to and from the log goes to the
vault's trace (`@estoc/vault`'s `TraceLog`, format §6.10): the frames it
sends and receives (`wire`: via, endpoint, size, HTTP status, duration;
`wire.bytes`: the ciphertext), every envelope sealed or opened (`envelope`:
kind, algorithms, key ids, the message type — no plaintext), the plaintext
of its rituals with mediators (`mediation`: status, delivery, grant,
recipient-update, forward), and what `onLog` was told (`diag`). Each line
names the observation it happened inside (`parent`), and an envelope that
ended in a log record names it (`mid`) — so `vault.trace.traceOf(mid)`
is the whole onion of one message, outermost frame to innermost seal,
written only after the record is. What the trace keeps and for how long
is the vault's `trace` option (`TRACE_NORMAL` by default, `TRACE_OFF`
writes nothing); the agent prunes it at every start and hourly, and a
trace that cannot be written is said on the log, never a reason to stop
moving mail.

### Moving a vault, and backends

`snapshotVault` / `importVault` and the `VaultBackend`s (`MemoryBackend`,
`OpfsBackend`, `FsBackend` in `@estoc/vault/node`) live in `@estoc/vault`;
see its README. The agent restarts on a merged vault: its stores cache
what they read, and a merge writes past them.

## Development

```
pnpm test       # vitest: identity (did:peer:4 over the vault), streaming AEAD, agent × fake mediator
pnpm build      # tsc → dist/
```

## License

Apache-2.0
