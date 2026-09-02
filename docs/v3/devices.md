# An identity's devices — draft

Status: **draft**, 2026-09-02; not implemented. Goes with version 3 of
the vault, version 1 of the device (`device.md`), and `devices/1.0`
(`devices-protocol.md`). Sections marked *provisional* are leanings,
not decisions. Design history:
`research/notes/2026-09-02-per-device-seed-and-agent-split.md` §5–§9.

The fifth document. `device.md` gives each device keys of its own and
keeps them there; `devices-protocol.md` says what a contact does with
a counterpart that has several devices; this one is the identity's own
side of that: which of the devices in its record are its own, what
each of them owes its contacts for its siblings, how two devices of
one identity are introduced to each other, and what becomes of a
device that is lost. What the devices exchange once introduced is
`sync.md`. It adds a few event types and folds to `vault-events.md`;
every event below is an event of `event-store.md` §2 and follows the
conventions of `vault-events.md` §1; the examples elide the envelope
as that document does.

**In one paragraph.** Among themselves the devices need no vouch and
no revoke on the wire: they share the vault, which says which device
minted which key, which device vouched for which, and which device was
retired, and what they exchange is the vault itself (`sync.md`).
Toward a contact, every device speaks for its siblings: each vouches
for every sibling key the contact may not know, each revokes every
retired sibling's keys, and each answers the challenges a contact
sends it — so that no introduction and no retirement waits on the one
device that happens to be offline. The anchor never leaves the
identity and signs one thing: the proof that makes the first device
its own (§3); what stands in when every device is lost is the
pre-commitment kept cold (`device.md` §1), which is the rotation
design's, not this document's.

## 1. Principles

1. **The devices share the vault, not a seed.** What one device knows
   of another is in the events — `device.minted`, `device.vouched`,
   `did.minted` with its `author`, `device.retired` — and the channel
   between two devices carries the vault (`sync.md`), not
   introductions. The one introduction is pairing (§6), which the
   person does by hand.
2. **A device is ours by a vouch, as a key is a contact's.** A
   signature says who wrote an event (`event-store.md` §2.5), not that
   the writer is one of us; being one of us is a decision,
   `device.vouched`, by a device that already is, rooted in the anchor
   (§3). What a contact's fold does with our keys
   (`devices-protocol.md` §7), the vault's fold does with our devices,
   over our own decisions instead of the wire: vouched, retired, in
   conflict, ruled.
3. **Every live device speaks for its siblings.** A vouch, a revoke and
   a challenge's answer are each sent by every device that can, not by
   the one that made the decision; the contact folds the copies to one
   (`devices-protocol.md` §3, §4). What a device owes is a fold of the
   vault (§5), so a device that was offline sends its share when it
   returns and nothing waits on it meanwhile.
4. **A retired device is retired by the vault, not by the wire.** The
   decision is an event any other device may write (`device.retired`,
   `vault-events.md` §5); its keys are dead to its siblings by the fold
   (§3, `vault-events.md` §7.3) and to its contacts by the revokes its
   siblings send (§5.2). Nothing is sent to a sibling to retire it.

## 2. Words

- **sibling** — another device of the same identity. Toward a
  contact, our siblings' keys are the ends the contact holds beside
  ours (`devices-protocol.md` §1); toward us, a sibling is an `author`
  whose events are in our vault and that is ours (§3).
- **ours** — the set of devices the vault's fold admits (§3): `self`,
  and every device a counted `device.vouched` names.
- **live / retired / conflict** — a device's state in the vault's fold
  (§3). Live: its decisions count. Retired: what it wrote after its
  retirement does not. Conflict: retired, and it went on writing;
  shown until ruled.
- **counted** — a decision from a device that is ours and live at that
  point in canonical order, and so took effect (§3). One from any
  other author is *suspect* and counts for nothing.
- **the self contact** — the one contact every device of the identity
  has, whose ends are its siblings (§7).
- **owed** — a vouch or a revoke the fold says `self` has not yet sent
  to a contact (§5).

## 3. Which devices are ours

A signature proves who wrote an event and nothing more
(`event-store.md` §2.5): any key can sign a `device.minted`, and a
copy of the vault that was tampered with — a backup altered where it
was kept, a sibling in a thief's hands — can carry one and everything
that key then signs. So a device is not ours by being in the set. It
is ours by a decision, and the decision has the shape a contact's has
toward our keys (`devices-protocol.md` §1 principle 2): adding is
vouching, by a device that is already ours.

```jsonc
{ "eid": "…", "author": "z6MkhaXg…", "at": "…", "type": "device.minted", "data": {} }
{ "type": "device.vouched", "data": { "dev": "z6MkhaXg…", "proof": "eyJ…" } }   // the root: by the anchor, for the creating device itself
{ "type": "device.vouched", "data": { "dev": "z6MkrJVn…" } }                     // by a device that is ours, at pairing
{ "type": "device.retired", "data": { "dev": "z6MkrJVn…", "because": "lost" } }
{ "type": "device.verdict", "data": { "dev": "z6MkrJVn…", "verdict": "live" } }
```

- `device.vouched { dev, proof? }`: `dev` is one of ours. Counted iff
  its `author` is ours and live at that point (the fold, below), or it
  carries a `proof`: a compact JWS, `EdDSA`, by the anchor's key — the
  did:key of `config.json` (`vault-folder.md` §6.1) — over the JCS
  serialization of `{ "anchor": <the anchor DID>, "dev": <dev> }`. A
  proof verifies against the anchor and nothing else, so the device
  that holds the anchor key (`device.md` §7, or one it was carried to
  as a `stored` key, `device.md` §4.1) can make any device ours,
  itself included, and no other key can. The first `device.vouched`
  of every vault is the creating device's own, with proof — the
  **root** — written with its `device.minted` at creation
  (`device.md` §7); every later one is written by the inviting device
  at pairing (§6), naming the newcomer, with no proof: the author's
  signature and the author's own membership are the grounds, and the
  author is, by construction, the device that introduced `dev`.
- `device.retired { dev, because }`: as `vault-events.md` §5, counted
  iff its `author` is ours and live at that point. A device may name
  itself (§5.3).
- `device.verdict { dev, verdict }`: the person's ruling on a device
  whose state the vault cannot settle — two devices that retired each
  other, below — `live` or `dead`. Counted from any device that is
  ours, live *or retired*: it is the person's hand on whichever
  device they hold, at the one point where the vault has already lost
  the means to tell. Latest wins per `dev` by canonical order. `dead`
  is a retirement in every effect; `live` clears one. Never sent:
  siblings learn it by sync, contacts by the revokes and vouches it
  makes owed (§5).

**The fold.** Per `self`, over the vault's events in canonical order
(`event-store.md` §3), a state per device — live, retired, conflict —
and the set **ours**:

1. `self` is ours: the device folding is a member to itself from its
   first open, whatever the set says of it; the state it reads for
   itself may be *retired* (§5.3).
2. A `device.vouched` whose `proof` verifies is counted: `dev` is
   ours, and live if it has no state yet.
3. A decision — `device.vouched`, `device.retired`, and every other
   decision of the vault (`vault-events.md` §1 principle 6) — authored
   by a device that is ours and live at this point is counted. A vouch
   makes `dev` ours, live if it has no state yet; a retirement makes
   `dev` retired, whether or not `dev` was ours yet, so that a device
   retired before it was vouched for is retired on arrival.
4. A decision authored by a device that is not ours, or that is retired
   at this point, is not counted: recorded, shown as **suspect**,
   applied to nothing. A retired device that goes on writing is in
   **conflict** — "a device this vault retired still writes" — as a
   dead end that speaks is to a contact (`devices-protocol.md` §6).
   Observations are recorded from any author, as always; what they
   are evidence of is a fold's question, and a fold reads the author.
5. A `device.verdict` from any device that is ours, live or retired, is
   counted: `dev` is live or retired as it says, its conflict cleared;
   later events apply to the new state.

Being ours has no time in it: a device vouched for today is ours for
every event it ever wrote, which is why a new device's first events —
its `device.minted`, the key it minted toward the sibling that paired
it — count once the vouch lands, on every device, in whatever order
sync brings them. Retirement is a point in canonical order: what a
device wrote before it counts, what it wrote after does not; and
canonical order is `at`, a wall clock, which is the weak joint here
(§9).

**What follows.** A device that arrives in a copy with no vouch — one
added to a backup the person did not make — is in the set and is not
ours: its `device.retired` retires nobody, its `identity.label` names
nothing, its `contact.*` bind no contact, and the application lists it
for what it is, a stranger in the record. A device that restores a
snapshot (`device.md` §7) is ours to itself and to nobody else until a
sibling vouches for it at pairing (§6). A restore with no sibling left
is the identity's whole record in one member's hands, which is what a
backup is for; it admits no second member until the anchor, or the
successor the rotation design pre-commits, is on some device to sign a
root again — the same case, inside the vault, that "all devices lost"
is toward every contact (§8). What a compromised device vouched for
before it was retired stands, as a contact's counted vouch does
(`devices-protocol.md` §10): each such device is listed, and is
retired by hand.

**Two devices, each retiring the other**, in the vault: whichever
retirement is first in canonical order is counted and the second is a
word from a retired device — a conflict on every device that holds
both. The honest device, if it lost that race, reads itself as
retired, stops acting (§5.3), and the person on it rules:
`device.verdict { dev: self, verdict: live }` and `{ dev: <the other>,
verdict: dead }`, counted by rule 5 from the retired device they hold.
The thief's device can write the mirror image, and the two records
disagree from then on — which the two no longer sync (`sync.md` §2)
and the contacts show (§8). The vault cannot tell which hand is
honest, and does not pretend to.

## 4. Keys, one per device

Every device that has a channel to a contact writes from a key of its
own: a `did/<id>` it minted (`vault-events.md` §2), `contact.useKey`'d
to that contact. A device that finds, on open or after a sync
(`sync.md`), a contact it has no live key toward **mints one then** —
`did.minted` plus `contact.useKey`, as today — and does not wait to
have something to say: the key exists so that a sibling can vouch for
it (§5.1) and the contact's next message reaches this device too. A
contact whose every device is thus reached by every device of ours is
the premise under which revocation works at all: a device only some
contacts know would go on receiving from the ones that were never told
(§5.2). A new contact and a new device both trigger this, for every
device of the identity; that it takes a sync to learn of either is the
cost of the lazy form (§9, a pool).

The key is registered with the device's own mediator and carries that
device's routing DID: each end of ours tells the contact which mediator
that device uses, no more than a single device did.

## 5. What a device owes its contacts

### 5.1 Vouches owed

A `devices/1.0` vouch (`devices-protocol.md` §3) is a `message.out`
like any other on the sending side, and the identity needs to know it
went — a sibling that was vouched for once need not be vouched for
again by this device — which the skeleton cannot say, the DID being in
the body. So a lifted observation, the shape of `profile.shared`:

```jsonc
{ "type": "did.vouched", "data": { "key": "did/0199…", "myKey": "did/0198…", "peerKey": "k3j9…", "mid": "0198…" } }
```

`key` the sibling's key that was vouched for, the pair the channel it
went on, `mid` the message. *Provisional*, as `profile.shared` is.

**Who vouches, and when.** Every live device, for every sibling key it
knows. The fold (§5.5) reports, per device `self` and per contact, the
**vouches owed**: each key `K` with a `did.minted` authored by a
sibling that is ours and live (§3), with a live `contact.useKey` on
this contact, and no `did.vouched { key: K }` authored by `self` on a
channel attributed to this contact — provided `self` has a channel to
write to the contact on. The agent sends one per owed key and lifts
the observation. Two siblings vouching for the same key is two edges
in the contact's graph and harmless; every device vouches so that the
introduction does not wait on the one sibling that happens to be
offline, and because of §5.2: a chain vouched for by every live
sibling is not orphaned when one of them is lost.

### 5.2 Revokes owed

A device that is retired in the vault — `device.retired { dev }`
(`vault-events.md` §5), a decision any other device may make, or the
device itself when it is being replaced — is retired toward every
contact by a `devices/1.0` revoke (`devices-protocol.md` §4) from
every live device that can reach them, naming every DID the retired
device's keys wore that this contact may know: the `did` of each
`did.minted` authored by the retired device whose key has a
`contact.useKey` on this contact or a channel attributed to it. The
sender names all it knows so that the contact need not have seen the
same ones. Never a device id.

The revoking side lifts, per message, one observation per key named:

```jsonc
{ "type": "did.revoked", "data": { "key": "did/0199…", "myKey": "did/0198…", "peerKey": "k3j9…", "mid": "0198…" } }
```

**Who revokes, and when.** Every live device, on its own. The fold
(§5.5) reports, per `self` and per contact, the **revokes owed**: the
keys of every retired device that this contact may know (as above)
for which no `did.revoked` authored by `self` exists on a channel
attributed to this contact, given a channel `self` can write on. One
message names them all. Every live device sends its own — not only the
one that appended `device.retired` — so the contact is told even if
that device never comes back online, and a contact with a channel to
only one of our devices is told by that one. Siblings are not sent
revokes: `device.retired` reaches them by sync, and a retired device's
keys are dead to them by the fold (§3, `vault-events.md` §7.3).

### 5.3 Challenges

**Answering.** A device answers every `devices/1.0` challenge it can
open (`devices-protocol.md` §5), automatically, whenever it is
unlocked — a device that is retired in its own vault included. **A
device that learns it is retired** — `device.retired` naming `self`
arrives by sync, and the fold of §3 counts it — shows it and does two
things at once: it stops every automatic act (no sending, no vouching,
no revoking, no sync outward, no handler side effects) and it **keeps
answering challenges**. It does not wipe itself: if the device that
retired it was the stolen one, this is the honest device, and its
answering the challenges is what tells every contact something is
wrong (§8). The person, on this device, either confirms — the
directory is deleted, `device.md` §7 — or rules the other way
(`device.verdict`, §3) and retires the other device from here, which
is a mutual revocation the contacts will show (`devices-protocol.md`
§7). A device the person retires *from itself*, replacing it, revokes
its own DIDs toward every contact before the directory is deleted, and
answers nothing after.

**Sending.** Every device of ours that folds a counted revoke from a
contact (`devices-protocol.md` §7) and finds no challenge sent yet by
any of its siblings — a `message.out` with the challenge's `msgType`
on a channel under the end's key, visible after sync — sends one; two
devices sending two, apart, is two answers folded to one
(`devices-protocol.md` §8). Whether a device sends challenges at all,
or leaves it to a sibling, is that device's option
(`agent/options.json`, `device.md` §5), the same option that governs
the other automatic replies (§5.4).

### 5.4 Acting once

A handler that answers a message — the profile a `user-profile` asks
back, a challenge's response — would answer from every device of ours
that received a copy (`devices-protocol.md` §8). Whether this device
acts on inbound at all is an option of the agent (`agent/options.json`,
`device.md` §5): `act`, default on. The first version accepts that two
devices with it on may answer twice, which the other side folds to one
message; a fold that lets a device see the sibling's answer first is a
sync away and is not relied on. What no device acts on is a word from
a dead end (`devices-protocol.md` §6).

### 5.5 The fold — our devices toward a contact

Added to `vault-events.md` §7.3, per `self` and per contact:

- **our keys toward it**: every `did/<id>` with a live `contact.useKey`
  on the contact, with the `author` of its `did.minted` — which device
  it is — and that device's state (§3); `self`'s own is the one `self`
  writes from, and "none" means mint (§4).
- **vouches owed** (§5.1) and **revokes owed** (§5.2), as defined
  there, each empty once `self` has done its part.
- The outbox drains them as it drains any message: they are
  `message.out`s in the contact's channel, retried until `sent`, held
  after an import like the rest (`vault-events.md` §10) — an imported
  copy's owed vouches are re-derived on the importing device, from its
  own `self`, and sent by it.

## 6. Pairing

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

The new device is born (`device.md` §7) and takes as its vault a
**restore of the identity's**: the first version bootstraps by
snapshot — export on the old device, restore into the new one's
`vault/` (`vault-folder.md` §9.4) — so that the new device opens
knowing the anchor, the contacts, the siblings' keys; its first open
appends its `device.minted`. It is ours to itself and to no one else
yet (§3). It then takes the invitation: mints a key for the purpose,
attaches the channel, and writes its first message to the invitation's
DID — a `sync/1.0/events` push (`sync.md` §2) carrying its own
`device.minted` and the `did.minted` of the key it just minted,
sealed from that key:

```jsonc
{ "type": "contact.created",  "data": { "cid": "0199…" } }
{ "type": "contact.attached", "data": { "cid": "0199…", "myKey": "did/019a…", "peerKey": "q4w8…", "because": "paired" } }
```

`because: paired` is the fourth value beside `invitation`, `accepted`
and `manual` (`vault-events.md` §6): this channel is to a device of
ours. The inviting device holds the message, unread by its store
(`sync.md` §2), and shows the person a device asking to join — the
`dev` that authored the `device.minted` it carries, whose signature
verified, and whose `did.minted` names the DID the envelope's key was
resolved under, so that the device named is the device that sealed
the message. On the person's accept it writes its own
`contact.created`, its own `contact.attached { because: paired }` on
the pair the envelope proved, and the vouch:

```jsonc
{ "type": "device.vouched", "data": { "dev": "z6MkrJVn…" } }
```

— then ingests the message. Two contacts, one on each device, both
`paired`: after the first sync they are one (§7), and the newcomer is
ours on every device the vouch reaches.

Pairing is by hand on both ends, as accepting a contact is, and is the
one place a device is introduced by a person rather than by the vault:
before the accept, neither device has evidence of the other beyond
the invitation the person carried across. From then on the evidence is
the vault's — the vouch, and everything the newcomer signs.

## 7. The self contact

Every contact with a live `contact.attached { because: paired }` is a
member of the **self contact**, and so is every channel whose peer key
a `peer.resolved` joins to a DID that a `did.minted` authored by a
device of ours (§3) records — the fold knows our own DIDs and needs no
vouch on the wire to recognise a sibling's key. All of them fold to one
component, the identity's own, with no `contact.merged`; the
application lists it as "your devices", not among contacts, and its
thread is not a conversation. Its ends are our devices, one per
sibling that has a key toward us, and their liveness is not
`devices-protocol.md` §7's: a sibling's chain is live iff the device
that minted its key is ours and live (§3) — the vault says, and no
vouch, revoke or verdict is exchanged among siblings. A channel
attached `paired` whose peer DID turns out, after sync, to be no key
of ours is shown as what it is: a stranger the person paired with, to
be detached — and, if a `device.vouched` was written for it, retired.

A sibling that a device learns of by sync before any channel exists —
a `device.vouched`, a `device.minted` and `did.minted`s from an
`author` it has no channel to — is reached as a contact is: the device
mints a key toward the self contact (§4) and writes to the sibling's
key toward self; the sibling's fold attributes the stranger channel to
self by the DID, which it holds by then or will after its next sync
from whoever paired the newcomer. So a device pairs with one sibling
and meets the rest without the person's hand: the third device of an
identity pairs with either of the two, and is ours to all three by the
one vouch.

What the siblings then exchange over these channels is `sync.md`.

## 8. Lifecycles

**A second device.** The person, on phone A, issues a pairing
invitation; exports a snapshot; restores it on laptop B, which is born
and appends `device.minted`; B takes the invitation, attaches `paired`,
and pushes its `device.minted`; A shows B's `dev`, the person accepts,
A attaches `paired` and vouches for B. Sync starts. B, seeing contacts
it has no key toward, mints one per contact and `contact.useKey`s
them; A, seeing B's keys by sync, owes a vouch per contact and sends
them. Each contact folds the vouch, gains a second live end, and from
its next message on seals to both. B is now reached by everyone A is,
and A by everyone B will meet.

**A device lost.** Phone A is lost. On B the person retires it:
`device.retired { dev: A, because: lost }`. B owes a revoke per contact
and sends them, naming A's DIDs toward each. Each contact folds the
revoke: A's chain is dead, nothing further is sealed to it, and a
challenge goes to it. A stays silent — off, wiped, locked, or in a
stranger's hands who does not answer — and the contact's application,
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
window between theft and retirement and nothing after it — a device
the thief vouched for in that window is one more to retire by hand
(§3) — and every contact learnt that something happened. The thief's
other move — to retire B *from A* first — is the next paragraph.

**Two devices, each retiring the other.** A and B each append
`device.retired` for the other and each revoke the other toward every
contact. In the vault, whichever is first in canonical order counts
and the other is a conflict (§3); the person, on the honest device,
rules it live and the other dead, and the two records part. The
contact folds whichever revoke arrived first as counted and the other
as a word from a dead chain: a conflict on the second end, and a
challenge to the first, which answers, since it is live and unlocked —
a conflict on it too. Two ends in conflict, no live end, nothing
sealed to either until the person rules, and the application says so:
"this contact's devices disagree about which of them is theirs; ask
them". The person rules one live, the other dead. Which end is honest,
the wire cannot say; that is what the phone call is for, and the only
silent path for the thief is the honest device never speaking again —
in which case it is, in every sense that matters, lost.

**A backup tampered with.** The person's backup, where it was kept,
gains a device: a key someone minted, a `device.minted` and a
`device.retired { dev: A }` it signed. The person restores or merges
it. The stranger is in the set and is nobody's: no vouch names it, so
its retirement of A retires nobody and nothing it signed counts; the
application lists a device in the record that no device of ours
introduced, which is the tampering, shown. What a backup cannot show
is what was left out of it (`event-store.md` §12).

**All devices lost.** The record is the backup (`device.md` §1); the
keys are gone; every contact's ends of ours are dead or will be. What
can vouch for a device that no device the contact knows can vouch for
is the pre-commitment the rotation design keeps cold, revealed and
carried onto a device as a `stored` key (`device.md` §4.1), and the
contact's fold for it is a vouch by a key it was promised rather than
one it knew; inside the vault it is the same key signing a root again
(§3). That fold is not in this version; without it, the identity
starts over toward every contact, by invitation, as a stranger who
knows what they said.

## 9. Versioning, open

- **Version.** The events here are additions within vault version 3
  (`vault-folder.md` §10): an older reader carries them unread and
  folds a contact to the one end it knew. The protocols are their own
  (`devices-protocol.md` §10, `sync.md` §4).
- **Canonical order is a wall clock.** Whether a decision was made
  before or after its author's retirement is read off `at`
  (`event-store.md` §3), which a stolen device can set as it likes: a
  vouch or a retirement backdated to before its own retirement is
  counted. The bound is the same as the contacts' — the person sees
  the device, or the conflict, and rules — and the fix, if one is
  needed, is the hybrid logical clock or the per-device chain
  `event-store.md` §12 keeps open, not a rule in this fold.
- **Verdicts from a retired device** are counted (§3 rule 5) so that
  the honest loser of a mutual retirement can rule from the device it
  holds; a thief holds the same power on the device it holds. A
  retired device's pushes are not ingested (`sync.md` §2), so its
  verdicts travel only by a copy the person carries; the fold shows
  every verdict with its author.
- **Vouches by a compromised device**, the identity's side. The
  introducer is now recorded — the `author` of the `device.vouched` —
  so a `since` on a revoke (`devices-protocol.md` §10) has what it
  needs of us; the contact's side of it is still open there.
- **A root without the anchor.** A restored record with no device that
  holds the anchor admits no second device (§3). The successor the
  rotation design pre-commits is the answer; until then a person who
  has lost every device keeps the record and starts the identity over.
- **A pool of keys** (§4): a device pre-minting keys and writing
  their public halves to the vault, so that a sibling meeting a new
  contact can vouch for the newcomer's key in the same breath and no
  sync is needed before the contact reaches every device. The lazy
  form is the first version.
- **Acting once.** The `act` option (§5.4) is the first version's
  whole answer to two devices answering twice. A device that waits one
  sync before acting, or a fold that assigns the answer to one device,
  is the next.
- **The self contact's channels** carry sync and nothing else; whether
  a person's note to themself across devices is a message in it, or
  an event of its own, is not decided.
- **Remote wipe** is not possible and is not promised: a retired
  device that cooperates deletes itself (§5.3), and one that does not
  is what the challenge exists for (`devices-protocol.md` §5).
