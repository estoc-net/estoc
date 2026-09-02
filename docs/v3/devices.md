# An identity's devices — draft

Status: **draft**, 2026-09-02; not implemented. Goes with version 3 of
the vault and version 1 of the device (`device.md`). Sections marked
*provisional* are leanings, not decisions. Design history:
`research/notes/2026-09-02-per-device-seed-and-agent-split.md` §5–§9.

The fifth document. `device.md` gives each device keys of its own and
keeps them there; this one is what follows for an identity that has
more than one device: how its devices appear to a contact, how a
contact comes to accept a new one and to drop one that is gone, what a
message from a dropped device means, how a sender writes to a contact
that has several, and how two devices of one identity are introduced
to each other and keep one record. It adds a few event types and folds
to `vault-events.md`, one small DIDComm protocol, `devices/1.0`, and
one more, `sync/1.0`, for the devices among themselves. Every event
below is an event of `event-store.md` §2 and follows the conventions of
`vault-events.md` §1; the examples elide the envelope as that document
does.

**The model, in one paragraph.** A contact never sees an identity; it
sees **ends** — the current DIDs of the keys that write to it — and
each end is one device of the identity, because every key is one
device's (`device.md` §4). An identity adds a device by having a device
the contact already knows **vouch** for the new one's key; it drops a
device by having any other device **revoke** its keys, which the
contact answers with a **challenge** to the revoked end; anything a
revoked end says afterwards, the challenge's answer included, is a
**conflict** the contact's person rules on, and nothing else is. A
sender writes once and seals to every live end. Among themselves the
devices need none of this: they share the vault, which already says
which device minted which key and which device was retired, and what
they exchange is the vault itself. The anchor never leaves the identity
and takes no part; what stands in when every device is lost is the
pre-commitment kept cold (`device.md` §1), which is the rotation
design's, not this document's.

## 1. Principles

1. **An end is a device.** What a contact holds of us is a set of
   keys, each minted by one device (`vault-events.md` §2), each wearing
   a DID; the DIDs a key wore in succession are a **chain**
   (`peer.rotated`, `vault-events.md` §3.1), and the chain's latest DID
   is its **end**. A contact with three ends of ours has three of our
   devices. Nothing tells a contact *which* device — no device id
   crosses the wire, ever, so that two contacts cannot compare notes and
   find they are talking to one identity (`vault-events.md` §2: names
   carry no decisions, and neither do envelopes).
2. **Adding is vouching; removing is revoking; both are said by a key
   the contact already trusts.** A vouch is a fact about the moment it
   was made and is not undone by what its maker later becomes. A revoke
   kills the chains it names, and only those.
3. **A revoked end has no second chance under that name.** Nothing a
   revoked chain says is acted on; every word from it is shown as a
   conflict; a device that comes back comes back with a new key,
   vouched afresh. Revocation is therefore sticky by construction and
   needs no ordering between vouch and revoke: whichever arrives first,
   the chain is dead.
4. **The contact's person is the arbiter, locally.** A conflict — a
   revoked end that speaks, two ends revoking each other — is a
   projection (`vault-events.md` §1 principle 4) and is resolved by a
   decision in the contact's own vault, never reported back. Timeouts
   are for showing, not for deciding: an end that answers late is a
   conflict, not a corpse.
5. **Send once, seal to every end.** Fan-out is the sender's, at the
   envelope; there is one message, with one wire id, and a copy per end
   (§4). Mediators do not know and need not.
6. **The devices share the vault, not a seed.** What one device knows
   of another is in the events — `device.minted`, `did.minted` with its
   `author`, `device.retired` — and the channel between two devices
   carries the vault (§5), not introductions. The one introduction is
   pairing (§5.1), which the person does by hand.

## 2. Words

- **chain** — the DIDs one key of a contact's wore in succession,
  joined by `peer.rotated` (`vault-events.md` §3.1, §7.1): a component
  of the identity graph under rotation edges alone. Every DID is in
  exactly one chain. A chain with two latest DIDs is a fork, shown as
  before (`vault-events.md` §7.2).
- **end** — a chain's latest DID; where a message to that device goes.
- **sibling** — another device of the same identity. Toward a
  contact, our siblings' keys are the ends the contact holds beside
  ours; toward us, a sibling is an `author` whose events are in our
  vault.
- **live / dead / conflict** — a chain's state in a contact's fold
  (§3.6). Live: written to, its words acted on. Dead: revoked, or
  ruled so; nothing goes to it but a challenge. Conflict: dead, and it
  spoke; shown until ruled.
- **the self contact** — the one contact every device of the identity
  has, whose ends are its siblings (§5.2).
- **counted** — a vouch or revoke that arrived from a live chain, and
  so took effect (§3.6). One from a dead chain is a word from a dead
  chain and counts for nothing.

## 3. Toward a contact

### 3.1 Keys, one per device

Every device that has a channel to a contact writes from a key of its
own: a `did/<id>` it minted (`vault-events.md` §2), `contact.useKey`'d
to that contact. A device that finds, on open or after a sync (§5.3),
a contact it has no live key toward **mints one then** — `did.minted`
plus `contact.useKey`, as today — and does not wait to have something
to say: the key exists so that a sibling can vouch for it (§3.2) and
the contact's next message reaches this device too. A contact whose
every device is thus reached by every device of ours is the premise
under which revocation works at all: a device only some contacts know
would go on receiving from the ones that were never told (§3.3). A new
contact and a new device both trigger this, for every device of the
identity; that it takes a sync to learn of either is the cost of the
lazy form (§8, a pool).

The key is registered with the device's own mediator and carries that
device's routing DID: each end of ours tells the contact which mediator
that device uses, no more than a single device did.

### 3.2 Vouch

A device the contact knows introduces a sibling's key:

```json
{
  "type": "https://estoc.dev/devices/1.0/vouch",
  "id": "<uuid>",
  "body": { "did": "did:peer:4…" }
}
```

- `body.did` — a DID of ours the contact may not know: the DID of a
  key a sibling minted toward this contact. One DID per message.
- Sealed authcrypt from the vouching device's key toward the contact,
  like every message; the envelope is the proof that a key the contact
  trusts said it, and no signature inside is required. The message is
  fanned out to every live end of the contact (§4).

The contact records what the envelope proved:

```jsonc
{ "type": "peer.vouched", "data": { "myKey": "did/0198…", "peerKey": "k3j9…", "by": "did:peer:4…B", "for": "did:peer:4…C", "mid": "0198…" } }
```

An observation on the channel that carried it (`vault-events.md`
§3.1): `by` is the DID the sealing key wore, `for` is `body.did`,
`mid` the message it came from. In the identity graph (`vault-events.md`
§7.1) it is an edge from `by` to `for`, so a channel later opened by a
key of `for`'s document is attributed to the contact the moment
`peer.resolved` joins it — or before any such channel exists, since
the contact may now write to `for` (§4) and `peer.resolved` before
sending fixes the pair. *Provisional:* written on receipt, as
`peer.rotated` is, rather than derived from the message on fold.

On the vouching side the message is a `message.out` like any other,
and the identity needs to know it went — a sibling that was vouched
for once need not be vouched for again by this device — which the
skeleton cannot say, the DID being in the body. So a lifted
observation, the shape of `profile.shared`:

```jsonc
{ "type": "did.vouched", "data": { "key": "did/0199…", "myKey": "did/0198…", "peerKey": "k3j9…", "mid": "0198…" } }
```

`key` the sibling's key that was vouched for, the pair the channel it
went on, `mid` the message. *Provisional*, as `profile.shared` is.

**Who vouches, and when.** Every live device, for every sibling key it
knows. The fold (§3.7) reports, per device `self` and per contact, the
**vouches owed**: each key `K` with a `did.minted` authored by a
sibling that is not retired, with a live `contact.useKey` on this
contact, and no `did.vouched { key: K }` authored by `self` on a
channel attributed to this contact — provided `self` has a channel to
write to the contact on. The agent sends one per owed key and lifts
the observation. Two siblings vouching for the same key is two edges
in the contact's graph and harmless; every device vouches so that the
introduction does not wait on the one sibling that happens to be
offline, and because of §3.3: a chain vouched for by every live
sibling is not orphaned when one of them is lost.

A sibling's key that was minted toward this contact but that the
contact has no channel under and no vouch for yet is a stranger to the
contact until the vouch lands (`vault-events.md` §7.1, unattributed);
the fold unions, so the order in which the sibling's first message
and the vouch arrive does not matter beyond what the contact's
application shows meanwhile.

### 3.3 Revoke

A device that is retired in the vault — `device.retired { dev }`
(`vault-events.md` §5), a decision any other device may make, or the
device itself when it is being replaced — is retired toward every
contact by a message from every live device that can reach them:

```json
{
  "type": "https://estoc.dev/devices/1.0/revoke",
  "id": "<uuid>",
  "body": { "dids": ["did:peer:4…B1", "did:peer:4…B2"] }
}
```

- `body.dids` — every DID the retired device's keys wore that this
  contact may know: the `did` of each `did.minted` authored by the
  retired device whose key has a `contact.useKey` on this contact or a
  channel attributed to it. Naming any DID of a chain kills the whole
  chain (§3.6); the sender names all it knows so that the contact need
  not have seen the same ones. Never a device id.
- Sealed from the revoking device's key toward the contact; fanned out
  to every live end of the contact (§4). A device may name its own
  DIDs: that is a device leaving, and needs no challenge.

The contact records:

```jsonc
{ "type": "peer.revoked", "data": { "myKey": "did/0198…", "peerKey": "k3j9…", "by": "did:peer:4…A", "dids": ["did:peer:4…B1", "did:peer:4…B2"], "mid": "0198…" } }
```

An observation on the channel that carried it; `by` the DID the
sealing key wore. Its effect is the fold's (§3.6): the named chains are
dead, from the moment the observation is folded, and a **challenge**
(§3.4) is owed to each. A DID named that is not in this contact's
component is ignored — recorded, shown, without effect: a revoke
reaches only the identity it came from. *Provisional*, as
`peer.vouched`.

The revoking side lifts, per message, one observation per key named:

```jsonc
{ "type": "did.revoked", "data": { "key": "did/0199…", "myKey": "did/0198…", "peerKey": "k3j9…", "mid": "0198…" } }
```

**Who revokes, and when.** Every live device, on its own. The fold
(§3.7) reports, per `self` and per contact, the **revokes owed**: the
keys of every retired device that this contact may know (as above)
for which no `did.revoked` authored by `self` exists on a channel
attributed to this contact, given a channel `self` can write on. One
message names them all. Every live device sends its own — not only the
one that appended `device.retired` — so the contact is told even if
that device never comes back online, and a contact with a channel to
only one of our devices is told by that one. Siblings are not sent
revokes: `device.retired` reaches them by sync (§5.3), and a retired
device's keys are dead to them by the fold (`vault-events.md` §7.3).

**A device that learns it is retired** — `device.retired` naming
`self` arrives by sync — shows it and does two things at once: it
stops every automatic act (no sending, no vouching, no revoking, no
sync outward, no handler side effects) and it **keeps answering
challenges** (§3.4). It does not wipe itself: if the device that
retired it was the stolen one, this is the honest device, and its
answering the challenges is what tells every contact something is
wrong (§6). The person, on this device, either confirms — the
directory is deleted, `device.md` §7 — or retires the other device from
here, which is a mutual revocation the contacts will show (§3.6). A
device the person retires *from itself*, replacing it, revokes its own
DIDs toward every contact before the directory is deleted, and answers
nothing after.

### 3.4 Challenge and response

A contact that has folded a counted revoke asks the revoked end whether
it is still there:

```json
{
  "type": "https://estoc.dev/devices/1.0/challenge",
  "id": "<uuid>",
  "body": { "by": "did:peer:4…A" }
}
```

- Sent to the revoked chain's end, sealed from a key of ours the end's
  key has a channel with (or a fresh pair, `peer.resolved` before
  sending). It is the one message a dead end is sent.
- `body.by` — the DID whose revoke this is, so that an honest device
  that answers knows which of its siblings retired it, and its person
  can tell whether that sibling is still theirs.
- Not sent when the revoke named the revoker's own chain (a device
  leaving), nor for a chain the person ruled dead (§3.5): there is
  nothing to ask.

```json
{
  "type": "https://estoc.dev/devices/1.0/response",
  "id": "<uuid>",
  "thid": "<the challenge's id>",
  "body": {}
}
```

A device answers every challenge it can open, automatically, whenever
it is unlocked — a device that is retired in its own vault included
(§3.3), and one that is wiped or locked cannot. The answer carries
nothing: the envelope is the whole claim, "the key you were told is
dead just sealed this". On the contact's side it is a `message.in` on
a dead chain and needs no type of its own in the fold: it is a word
from a dead end (§3.6), and the chain is in conflict.

**Who challenges.** Every device of the contact's that folds the
revoke and finds no challenge sent yet by any of its siblings — a
`message.out` with the challenge's `msgType` on a channel under the
end's key, visible after sync — sends one; two devices sending two,
apart, is two answers folded to one (§4). Whether a device sends
challenges at all, or leaves it to a sibling, is that device's option
(`agent/options.json`, `device.md` §5), the same option that governs
the other automatic replies (§4).

**Timeout.** How long the application shows "checking" before it
shows "gone" is the application's; nothing in the fold changes when it
expires. The chain was dead from the revoke; an answer that comes a
month later is a conflict all the same, which is why a device that is
closed, locked, or offline while the challenge waits loses nothing:
whenever it wakes it answers, and whenever it answers the conflict is
shown.

### 3.5 A word from a dead end, and the verdict

Every observation on a channel whose chain is dead — a message, a
vouch, a revoke, a rotation, a response — is recorded as it is (an
observation is never refused a home, `vault-events.md` §7.4) and does
three things and nothing else: it puts the chain in **conflict**; it
is shown, marked; it is not acted on — no handler runs on it, no reply
is sent, no vouch or revoke or rotation it carries takes effect, and
the chain it extends stays dead. What the person then does is a
decision:

```jsonc
{ "type": "contact.verdict", "data": { "cid": "0198…", "did": "did:peer:4…B1", "verdict": "live" } }
{ "type": "contact.verdict", "data": { "cid": "0198…", "did": "did:peer:4…A",  "verdict": "dead" } }
```

- `did` names a chain, by any DID in it; `verdict` is `live` or
  `dead`. A decision about one contact (`vault-events.md` §6),
  latest-wins per chain by canonical order.
- `live` — the person has satisfied themself, off the wire, that this
  is their contact's device: the chain is live again, written to, its
  words acted on from here on. It says nothing about the end that
  revoked it; the person rules on that one too if they mean to, and
  usually does (§6: if the old phone is honest, the one that revoked it
  is not).
- `dead` — the person has decided it is gone: no challenge is sent, its
  words are conflicts. A revoke need not have come first; a person told
  by their contact over the phone that a device is lost may rule it so
  before the identity's other devices have said anything.
- A verdict is one more event in canonical order: a later counted
  revoke kills a chain ruled live, a later word from a chain ruled dead
  is a conflict again, and a `live` verdict for a chain that a sibling
  later re-vouches changes nothing it did not already say.
- Never sent. The other side is told nothing; what it did with its
  devices is its own vault's business, and what we believe is ours.

### 3.6 The fold — a contact's ends

`vault-events.md` §7.1 builds the identity graph and §7.2 reads the
contact's DIDs off it; this fold refines the second. The identity
graph gains one edge: a counted `peer.vouched` joins `by` to `for`.
Components still define contacts; within a component, **chains** are
the components under `peer.rotated` edges alone.

Walk the contact's events in canonical order (`event-store.md` §3),
keeping a state per chain and a set of **named-dead** DIDs:

1. **A chain appears** through a live `contact.attached` channel under
   one of its DIDs — it is **live**; through a counted vouch — it
   joins the component, **live** unless one of its DIDs is named-dead,
   then **dead**; through nothing else. A channel a stranger opened is
   in no component and no chain of any contact (`vault-events.md`
   §7.1) until a vouch or an attach brings it in.
2. **`peer.revoked` on a live chain** is counted. Every chain that
   contains a named DID is **dead**, its `revokedBy` the revoking
   chain; a named DID no chain contains yet is added to named-dead,
   so the chain that later contains it is dead on arrival. Named DIDs
   outside the component are ignored. A revoke that names its own
   chain is that chain's own leaving: dead, and no challenge is owed.
3. **`peer.vouched` on a live chain** is counted: the edge stands, and
   stands after the vouching chain's death. `for`'s chain is live or
   dead by rule 1.
4. **`peer.rotated` on a live chain** extends it, as before.
5. **Any observation on a dead chain** — rules 2 to 4 not applied, a
   `message.in`, a response — sets the chain to **conflict**, and is
   recorded with it. Nothing it carries is an edge or a kill.
6. **`contact.verdict`** sets the chain it names to **live** or
   **dead**, clearing `revokedBy` and the conflict; later events apply
   to the new state.

What the fold reports, added to `vault-events.md` §7.2's contact
state:

```ts
type End = {
  did: string;                            // the chain's end
  chain: string[];                        // its DIDs, oldest first
  state: "live" | "dead" | "conflict";
  vouchedBy: string[];                    // the `by` of every counted vouch for it; [] for an attached chain
  revokedBy: string | null;               // the end of the chain that revoked it, when a revoke did
  challenged: boolean;                    // some device of ours sent a challenge to it
  words: string[];                        // the `mid`s of what it said while dead, in order
};
```

- `ends[]`: one per chain, in order of first appearance. Replaces
  "the current DID is a chain's end; two ends = a conflict": several
  ends are several devices, and a *fork* — one chain with two latest
  DIDs — is the conflict that was.
- `writeTo`: for every **live** end, the unfrozen channels
  (`vault-events.md` §3.2) from a key of `self`'s to that end's
  current keys (the latest `peer.resolved` for it); per end, the rule
  of `vault-events.md` §7.2 picks one when there are several. Empty
  for a contact with no live end — the person is told, and the
  conflicts (if any) are where the answer is.
- `challenges[]`: every end that is `dead` by a counted revoke that
  was not its own, has no verdict, and is not `challenged`.
- A message's `did` (`vault-events.md` §3.1) says which end sent it;
  the application shows the contact's devices, and beside each message
  which one, without a name for any of them.

Two devices of ours fold this each from their own observations and
union by sync (§5.3): both may see the same vouch, arrived on each's
own channel, as two counted edges; both may challenge; the last
verdict wins. None of it needs a rule beyond canonical order.

### 3.7 The fold — our devices toward a contact

Added to `vault-events.md` §7.3, per `self` and per contact:

- **our keys toward it**: every `did/<id>` with a live `contact.useKey`
  on the contact, with the `author` of its `did.minted` — which device
  it is — and whether that device is retired; `self`'s own is the one
  `self` writes from, and "none" means mint (§3.1).
- **vouches owed** (§3.2) and **revokes owed** (§3.3), as defined
  there, each empty once `self` has done its part.
- The outbox drains them as it drains any message: they are
  `message.out`s in the contact's channel, retried until `sent`, held
  after an import like the rest (`vault-events.md` §10) — an imported
  copy's owed vouches are re-derived on the importing device, from its
  own `self`, and sent by it.

## 4. Sending to many ends

A message to a contact is written once and goes to every live end:

- One plaintext, with one `id`; its `to` names every end it goes to.
  One **copy per end**: a `message.out` in the channel from `self`'s
  key to that end's key, all sharing the `wireId` and the same body
  root (the plaintext is one blob; the skeletons name it), each sealed
  to its end, each delivered on its own with its own
  `delivery.attempted`s. The channel model gains no shape: fan-out is
  N skeleton lines over one blob.
- **The thread folds by wire id.** Within a contact (`vault-events.md`
  §7.2 `thread`), skeleton lines that share a `wireId` and a direction
  are one message: the copies of one outbound to several ends, or the
  copies of one inbound that the contact sealed to several keys of
  ours and that reached us on several devices. The message's
  deliveries are the union of its copies'; erasing it erases every
  copy (`message.erased` per `mid`, `vault-events.md` §8.1, the roots
  going when the last copy drops them). Dedup is by `(cid, direction,
  wireId)`; a wire id is the sender's claim and is never a storage
  identity (`event-store.md` §3), which is exactly why the copies keep
  their own `mid`s.
- **Inbound, on each of our devices.** A contact fans out to our ends
  the same way; each of our devices receives its own copy, in its own
  channel, and appends its own `message.in`. After sync every device
  holds every copy, folded to one line of the thread. A device that
  was never reached — the contact did not have its end yet — reads the
  message from its sibling's copy, which is what a sync is for.
- **A message from an end we do not know** — a sibling of the contact's
  the contact has not yet had vouched for to us — is a stranger's until
  the vouch lands (§3.2). A message from a dead end is §3.5.
- **Side effects, once.** A handler that answers a message — the
  profile a `user-profile` asks back, a challenge's response — would
  answer from every device of ours that received a copy. Whether this
  device acts on inbound at all is an option of the agent
  (`agent/options.json`, `device.md` §5): `act`, default on. The first
  version accepts that two devices with it on may answer twice, which
  the other side folds to one message; a fold that lets a device see
  the sibling's answer first is a sync away and is not relied on. What
  no device acts on is a word from a dead end (§3.5).

The contact's mediators are told nothing new: each copy is a forward
to the routing DID of the end it goes to, as a single-device message
was. A contact whose devices share a mediator gets N forwards to one
service; that mediator sees N envelopes to N recipient keys, as it
would from N different senders.

## 5. Among siblings

### 5.1 Pairing

Two devices of one identity meet the way two contacts do: an
invitation, taken. The person, on a device that has the vault, issues
one for a new device, and the format of it is `out-of-band/2.0` as for
anyone — a `did/<id>` minted for it, published once:

```jsonc
{ "type": "did.published", "data": { "key": "did/0198…", "as": "pairing", "oobId": "…", "uses": "one" } }
```

`as: pairing` is the third value beside `oob` and `profile`
(`vault-events.md` §5); on the wire the invitation's `goal_code` is
`pair` where a contact's is `connect`, so that the device taking it
knows what it is taking and shows no contact-adding UI. The fold of
invitations (`vault-events.md` §7.4) treats it as any one-use
invitation.

The new device is born (`device.md` §7) with a vault of its own that is
a **restore of the identity's**: the first version bootstraps by
snapshot — export on the old device, restore on the new
(`vault-folder.md` §9.4) — so that the new device opens knowing the
anchor, the contacts, the siblings' keys; its first open appends its
`device.minted`. It then takes the invitation: mints a key for the
purpose, writes its first message to the invitation's DID, and attaches
the channel:

```jsonc
{ "type": "contact.created",  "data": { "cid": "0199…" } }
{ "type": "contact.attached", "data": { "cid": "0199…", "myKey": "did/019a…", "peerKey": "q4w8…", "because": "paired" } }
```

`because: paired` is the fourth value beside `invitation`, `accepted`
and `manual` (`vault-events.md` §6): this channel is to a device of
ours. The inviting device, on the person's accept there, does the
same — its own `contact.created`, its own `contact.attached { because:
paired }` on the pair the envelope proved. Two contacts, one on each
device, both `paired`: after the first sync they are one (§5.2).

Pairing is by hand on both ends, as accepting a contact is, and is the
one place a device is introduced by a person rather than by the vault:
before the sync that follows, neither device has evidence of the other
beyond the invitation the person carried across. From then on the
evidence is the vault's.

### 5.2 The self contact

Every contact with a live `contact.attached { because: paired }` is a
member of the **self contact**, and so is every channel whose peer key
a `peer.resolved` joins to a DID that one of our own `did.minted`
records (`vault-events.md` §5) — the fold knows our own DIDs and needs
no vouch to recognise a sibling's key. All of them fold to one
component, the identity's own, with no `contact.merged`; the
application lists it as "your devices", not among contacts, and its
thread is not a conversation. Its ends are our devices, one per
sibling that has a key toward us, and their liveness is not §3.6's: a
sibling's chain is live iff the device that minted its key is not
retired (`vault-events.md` §7.3) — the vault says, and no vouch,
revoke or verdict is exchanged among siblings. A channel attached
`paired` whose peer DID turns out, after sync, to be no key of ours is
shown as what it is: a stranger the person paired with, to be
detached.

A sibling that a device learns of by sync before any channel exists —
a `device.minted` and `did.minted`s from an `author` it has no channel
to — is reached as a contact is: the device mints a key toward the
self contact (§3.1) and writes to the sibling's key toward self; the
sibling's fold attributes the stranger channel to self by the DID,
which it holds by then or will after its next sync from whoever paired
the newcomer. So a device pairs with one sibling and meets the rest
without the person's hand: the third device of an identity pairs with
either of the two.

### 5.3 Sync — *provisional*

What siblings exchange is the vault: events, and the blocks those
events hold. The folder is the interchange format (`event-store.md`
§10.1) and a sync is "ingest what the other holds that I lack"
(`vault-folder.md` §10). Two things do it, and only the second is
relied on. A **push** carries what a device has just appended to
every live sibling, at once, for latency; it promises nothing. A
**reconciliation** compares the two sets and fills whichever side is
short, on open and on a timer, for convergence: it remembers nothing
between rounds, so nothing a device forgets, drops, or fails to write
is skipped for good — it is a difference the next round shows again.
`ingest` is idempotent (`event-store.md` §4.2), so sending what the
other already holds costs a message and nothing else, and the protocol
errs that way throughout.

**Push.** After every `append`, the device sends the events it
appended to each live sibling, with those of their blocks that fit:

```json
{
  "type": "https://estoc.dev/sync/1.0/events",
  "id": "<uuid>",
  "body": { "store": null, "events": [ { "eid": "…", "at": "…", "author": "…", "type": "…", "blobs": [], "data": {} } ] },
  "attachments": [
    { "id": "bafkrei…", "media_type": "application/vnd.ipld.raw", "byte_count": 100, "data": { "base64": "…" } }
  ]
}
```

- `body.store` — `null` for the vault's own set, an `ext` for an
  extension store's (`event-store.md` §8); each store is synced as the
  set it is. A store the fold over this device's vault set says is
  purged (`vault-events.md` §7.3) is neither pushed nor reconciled;
  one this device does not yet hold comes into being with the first
  write, as on import (`event-store.md` §10.3).
- `body.events` — envelopes as `event-store.md` §2 defines them, in no
  promised order, as many as fit under the mediator's envelope limit
  with their blocks; the rest in another message; a message may carry
  blocks and no events, as an answer to a `want` does (below). The
  receiver `ingest`s (`event-store.md` §4.2): duplicates skipped,
  conflicts reported, and an event of `self` it never wrote is a
  forked self and stops the ingest — a sibling that sends us our own
  events back is fine, one that sends us events of ours we do not
  have is the fault that check exists for. Every event carries its
  author's signature (`event-store.md` §2.5) and `ingest` checks it,
  so a sibling can relay any device's events and forge none: what a
  message says C wrote is what C wrote, or is rejected. Sync rests on
  this — without it a compromised sibling could write in a live
  device's name and leave words behind that its own retirement would
  not make suspect.
- `attachments` — blocks, by CID as `object-share.md` §2 carries them:
  those the message's events hold (`vault-events.md` §8.3) that fit
  inline; ones that do not travel by package (`object-share.md` §8) or
  are left out — a block a line names and the store lacks is
  *missing*, `vault-events.md` §8.2 says what that reads as, and the
  receiver's next `want` asks for it. A receiver writes the blocks a
  message carries before it ingests its lines (`event-store.md` §5.2);
  the gap this leaves for blocks left out is the one that rule allows.
  Blocks come in by collectability, as a merge's do (`vault-events.md`
  §10): an erased blob is never sent.
- Files (`state/` and the unknown paths, `vault-folder.md` §6) are not
  in the first version's sync; a backup carries them.

A push that is lost, or reaches a device that crashes before it wrote,
or is stopped by a forked self, is gone: no token, no receipt and no
retry stand behind it, because none is needed. The reconciliation is
what converges, and a device keeps no record of what it pushed to
whom — such a record would be the per-device high-water mark
`event-store.md` §4.2 says not to keep, and its being wrong would be a
silent divergence, which is the one failure a sync must not have.

**Reconciliation.** An `eid` is a UUIDv7, so a store's events sorted
by `eid` are in mint order, and a **range** `[from, to)` of that order
is a slice of the set that both sides can compute over. The order is
the `eid`'s, not `at`'s, and each side computes over the events it
holds, so an author that mints `eid`s out of time makes ranges
lopsided and never makes equal sets compare unequal. A device opens a
round with `have`: its set as ranges, each a fingerprint or, when
small enough, the `eid`s themselves; and `want`, the blocks it lacks:

```json
{
  "type": "https://estoc.dev/sync/1.0/have",
  "id": "<uuid>",
  "body": {
    "store": null,
    "ranges": [
      { "from": null,     "to": "0198a…", "count": 4812, "hash": "b0Wm…" },
      { "from": "0198a…", "to": "0198f…", "count": 37,   "hash": "k7q3…" },
      { "from": "0198f…", "to": null,     "eids": [ "0198f…", "0198f…" ] }
    ],
    "want": [ "bafkrei…" ]
  }
}
```

- `ranges` — in the `have` that opens a round, cover the whole order
  in order, `from: null` the beginning and `to: null` the end, so that
  the message states the sender's whole set; in a reply, only the
  ranges still in question. A range is a **fingerprint** — `count`,
  and `hash`, the sha-256 of the sender's `eid`s in it, sorted and
  concatenated, base64url — or a **list**, `eids`, the `eid`s
  themselves. How a sender cuts ranges is its own: it lists a range it
  can list under the envelope limit and fingerprints the rest, and on
  a later turn splits a fingerprint that came back unequal; the other
  side computes over the bounds it is given, whatever they are. A
  device may remember when it was last level with a sibling and
  fingerprint everything before that as one range — a cache, lost
  harmlessly.
- `want` — the CIDs of blocks the sender lacks that a root it holds
  (`vault-events.md` §8.3) reaches: the frontier at which its walk
  stops. Answered with the blocks a root the *answerer* holds reaches,
  and no others — an erase on the answering side wins, as always —
  inline or by package; what is still missing is the next `want`'s.

The receiver of a `have` computes, for each range, its own fingerprint
or list over the same bounds and compares. An equal range is done. A
listed range says exactly which `eid`s each side lacks: the receiver
pushes what the list lacks, by `sync/1.0/events` with blocks as a push
carries them, and returns the range, listed, only if the list holds
what it lacks — so that the other side pushes in turn. A fingerprint
that differs says only that the range differs: the receiver returns
it, split or listed, so that the next turn narrows it. Its reply is a
`have` of the ranges it returns and its own `want`; a `have` that
returns no range ends the round, and whether the last push landed is
the next round's question, not this one's. Two rounds open at once,
one from each side, are two rounds: nothing in a `have` refers to an
earlier message.

After a round in which no message was lost, two live siblings hold the
same events, and the same blocks for every root both hold, less what
would not go under the limit and package; after a round in which
something was lost, the next round shows the difference again. What
each side states is what it holds, never what it sent or was sent,
which is what makes a round repeatable and the loss of any local
state a slower first turn and nothing else. A forked self stops an
`ingest` and is reported, and reconciliation does not paper over it:
the range stays unequal round after round until the person acts
(`event-store.md` §4.2) — the alarm, not a fault of the sync. A
retired device is sent nothing, no round is opened toward it, and a
`have` from it is not answered; what it pushes is ingested and folds
as its events do — suspect (`vault-events.md` §5).

A device new to the identity starts, in this version, from a snapshot
(§5.1). A round from an empty set is the whole vault and would
converge — every range unequal, every event pushed — but through the
mediator's envelopes, which is what the zip spares; a first sync that
replaces the zip is open (§8). The cost is the mediator's: a `have` is
one hash per range, a round localises a difference to the ranges that
hold it, a level pair exchanges a few hundred bytes and a device back
after a week exchanges the week. A round takes the turns its ranges
need, and each turn waits for the other device to be online.

## 6. Lifecycles

**A second device.** The person, on phone A, issues a pairing
invitation; exports a snapshot; restores it on laptop B, which is born
and appends `device.minted`; B takes the invitation, attaches `paired`;
A accepts, attaches `paired`. Sync starts. B, seeing contacts it has no
key toward, mints one per contact and `contact.useKey`s them; A,
seeing B's keys by sync, owes a vouch per contact and sends them. Each
contact folds `peer.vouched`, gains a second live end, and from its
next message on seals to both. B is now reached by everyone A is, and
A by everyone B will meet.

**A device lost.** Phone A is lost. On B the person retires it:
`device.retired { dev: A, because: lost }`. B owes a revoke per contact
and sends them, naming A's DIDs toward each. Each contact folds
`peer.revoked`: A's chain is dead, nothing further is sealed to it,
and a challenge goes to it. A stays silent — off, wiped, locked, or in
a stranger's hands who does not answer — and the contact's application,
after its own time, shows A as gone. Nobody ruled; nobody had to. A's
messages are history in every vault, its keys are gone with it
(`device.md` §7), and the identity is B alone until the next pairing.

**A device replaced.** The person, on phone A, retires it from itself
before wiping it: `device.retired { dev: A, because: replaced }`, and
A's own revokes naming its own DIDs go out first. Each contact folds a
revoke from the chain it names: dead, no challenge. Then A's directory
is deleted. The new phone pairs with B as above.

**A stolen device that talks.** Phone A is stolen unlocked. B retires
it; contacts revoke it and challenge it. The thief's A, unlocked,
answers — the agent answers challenges without asking. Each contact's
fold puts A in conflict; each application shows "a device this contact
retired says it is still theirs"; each person asks their contact, off
the wire, and rules: `contact.verdict { did: A, verdict: dead }`, or
nothing, which is the same. Noisy, and right: the thief gained the
window between theft and retirement and nothing after it, and every
contact learnt that something happened. The thief's other move — to
retire B *from A* first — is the next paragraph.

**Two devices, each retiring the other.** A and B each append
`device.retired` for the other and each revoke the other toward every
contact. The contact folds whichever revoke arrived first as counted
and the other as a word from a dead chain: a conflict on the second
end, and a challenge to the first, which answers, since it is live and
unlocked — a conflict on it too. Two ends in conflict, no live end,
nothing sealed to either until the person rules, and the application
says so: "this contact's devices disagree about which of them is
theirs; ask them". The person rules one live, the other dead. Which
end is honest, the wire cannot say; that is what the phone call is
for, and the only silent path for the thief is the honest device never
speaking again — in which case it is, in every sense that matters,
lost.

**All devices lost.** The record is the backup (`device.md` §1); the
keys are gone; every contact's ends of ours are dead or will be. What
can vouch for a device that no device the contact knows can vouch for
is the pre-commitment the rotation design keeps cold, revealed and
carried onto a device as a `stored` key (`device.md` §4.1), and the
contact's fold for it is a vouch by a key it was promised rather than
one it knew. That fold is not in this version; without it, the
identity starts over toward every contact, by invitation, as a
stranger who knows what they said.

## 7. What a contact can see

Each contact sees how many ends of ours it holds, when each appeared
and was vouched for, and when one was revoked and by which; it sees
which end each message came from. It sees no device id, no label, no
key name and no sibling's DID toward anyone else, and two contacts
comparing what they see find only that each holds N chains of an
identity — the same N, changing at the same moments, which is the one
correlation this design accepts, as it accepts that a contact sees
which mediator each device uses. Nothing here changes what the
mediators see: N recipients where there was one, each registered by
its own device, each forwarded to on its own.

## 8. Versioning, open

- **Version.** `devices/1.0` and `sync/1.0` are DIDComm protocols and
  version as such; the events here are additions within vault version
  3 (`vault-folder.md` §10): an older reader carries them unread and
  folds a contact to the one end it knew.
- **A contact that does not speak `devices/1.0`** folds no vouch: our
  siblings are strangers to it and stay so. Toward such a contact the
  identity is one device — whichever it attached — and a change of
  device is what it was before this document: a `from_prior` rotation
  from the device it knows to the one replacing it, a replacement, not
  an addition, done by the old device while it still can. A problem
  report for an unknown type is what tells the vouching device so, and
  is shown.
- **A signed vouch.** The envelope is the proof (§3.2) and the
  contact's own fold the only reader; a JWS inside — the shape
  `from_prior` has — would let a third party check it, and is what the
  cold pre-commitment's vouch (§6) will need, since that key never
  seals an envelope. Add it then, as an optional `proof` on `vouch`
  and `revoke`.
- **Vouches by a compromised device.** A vouch is a fact (§1
  principle 2): a device that was stolen and, before it was retired,
  vouched a stranger's key toward a contact has planted an end the
  revoke does not name, unless the identity's other devices learnt of
  it by sync and retired it too. Bounding the damage — a `since` on the
  revoke after which the named chains' vouches do not count, matched
  against the contact's own observation times; or the contact's
  application marking an end whose every voucher has since been revoked
  — is not in this version, and neither is a primary device that alone
  may vouch, which is how the services that share this model close the
  hole. A `since` needs to know which device introduced which — for a
  sibling that arrived by sync, the sibling whose message carried its
  `device.minted` (`vault-events.md` §11) — which sync does not yet
  record.
- **A pool of keys** (§3.1): a device pre-minting keys and writing
  their public halves to the vault, so that a sibling meeting a new
  contact can vouch for the newcomer's key in the same breath and no
  sync is needed before the contact reaches every device. The lazy
  form is the first version.
- **Sync** (§5.3) is provisional throughout: a push of each append
  and a reconciliation by `eid` ranges, blocks by `want`, files not
  carried, zip to bootstrap. The bounds — how a sender cuts ranges,
  the timer, how much a `want` asks at once — are a client's and are
  unstated; a first sync that replaces the zip is the likely change.
  None of it touches an event type here.
- **Acting once.** The `act` option (§4) is the first version's whole
  answer to two devices answering twice. A device that waits one sync
  before acting, or a fold that assigns the answer to one device, is
  the next.
- **The self contact's channels** carry sync and nothing else; whether
  a person's note to themself across devices is a message in it, or
  an event of its own, is not decided.
- **Remote wipe** is not possible and is not promised: a retired
  device that cooperates deletes itself (§3.3), and one that does not
  is what §3.4 and §3.5 are for.
