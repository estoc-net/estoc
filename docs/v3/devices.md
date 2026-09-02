# An identity's devices — draft

Status: **draft**, 2026-09-02; not implemented. Goes with version 3 of
the vault, version 1 of the device (`device.md`), and `devices/1.0`
(`devices-protocol.md`). Sections marked *provisional* are leanings,
not decisions. Design history:
`research/notes/2026-09-02-per-device-seed-and-agent-split.md` §5–§9.

The fifth document. `device.md` gives each device keys of its own and
keeps them there; `devices-protocol.md` says what a contact does with
a counterpart that has several devices; this one is the identity's own
side of that: what each of its devices owes its contacts for its
siblings, how two devices of one identity are introduced to each
other, and what becomes of a device that is lost. What the devices
exchange once introduced is `sync.md`. It adds a few event types and
folds to `vault-events.md`; every event below is an event of
`event-store.md` §2 and follows the conventions of `vault-events.md`
§1; the examples elide the envelope as that document does.

**In one paragraph.** Among themselves the devices need no vouch and
no revoke on the wire: they share the vault, which says which device
minted which key and which device was retired, and what they exchange
is the vault itself (`sync.md`). Toward a contact, every device speaks
for its siblings: each vouches for every sibling key the contact may
not know, each revokes every retired sibling's keys, and each answers
the challenges a contact sends it — so that no introduction and no
retirement waits on the one device that happens to be offline. The
anchor never leaves the identity and takes no part; what stands in
when every device is lost is the pre-commitment kept cold (`device.md`
§1), which is the rotation design's, not this document's.

## 1. Principles

1. **The devices share the vault, not a seed.** What one device knows
   of another is in the events — `device.minted`, `did.minted` with its
   `author`, `device.retired` — and the channel between two devices
   carries the vault (`sync.md`), not introductions. The one
   introduction is pairing (§5), which the person does by hand.
2. **Every live device speaks for its siblings.** A vouch, a revoke and
   a challenge's answer are each sent by every device that can, not by
   the one that made the decision; the contact folds the copies to one
   (`devices-protocol.md` §3, §4). What a device owes is a fold of the
   vault (§4), so a device that was offline sends its share when it
   returns and nothing waits on it meanwhile.
3. **A retired device is retired by the vault, not by the wire.** The
   decision is an event any other device may write (`device.retired`,
   `vault-events.md` §5); its keys are dead to its siblings by the fold
   (`vault-events.md` §7.3) and to its contacts by the revokes its
   siblings send (§4.2). Nothing is sent to a sibling to retire it.

## 2. Words

- **sibling** — another device of the same identity. Toward a
  contact, our siblings' keys are the ends the contact holds beside
  ours (`devices-protocol.md` §1); toward us, a sibling is an `author`
  whose events are in our vault.
- **the self contact** — the one contact every device of the identity
  has, whose ends are its siblings (§6).
- **owed** — a vouch or a revoke the fold says `self` has not yet sent
  to a contact (§4).

## 3. Keys, one per device

Every device that has a channel to a contact writes from a key of its
own: a `did/<id>` it minted (`vault-events.md` §2), `contact.useKey`'d
to that contact. A device that finds, on open or after a sync
(`sync.md`), a contact it has no live key toward **mints one then** —
`did.minted` plus `contact.useKey`, as today — and does not wait to
have something to say: the key exists so that a sibling can vouch for
it (§4.1) and the contact's next message reaches this device too. A
contact whose every device is thus reached by every device of ours is
the premise under which revocation works at all: a device only some
contacts know would go on receiving from the ones that were never told
(§4.2). A new contact and a new device both trigger this, for every
device of the identity; that it takes a sync to learn of either is the
cost of the lazy form (§8, a pool).

The key is registered with the device's own mediator and carries that
device's routing DID: each end of ours tells the contact which mediator
that device uses, no more than a single device did.

## 4. What a device owes its contacts

### 4.1 Vouches owed

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
knows. The fold (§4.5) reports, per device `self` and per contact, the
**vouches owed**: each key `K` with a `did.minted` authored by a
sibling that is not retired, with a live `contact.useKey` on this
contact, and no `did.vouched { key: K }` authored by `self` on a
channel attributed to this contact — provided `self` has a channel to
write to the contact on. The agent sends one per owed key and lifts
the observation. Two siblings vouching for the same key is two edges
in the contact's graph and harmless; every device vouches so that the
introduction does not wait on the one sibling that happens to be
offline, and because of §4.2: a chain vouched for by every live
sibling is not orphaned when one of them is lost.

### 4.2 Revokes owed

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
(§4.5) reports, per `self` and per contact, the **revokes owed**: the
keys of every retired device that this contact may know (as above)
for which no `did.revoked` authored by `self` exists on a channel
attributed to this contact, given a channel `self` can write on. One
message names them all. Every live device sends its own — not only the
one that appended `device.retired` — so the contact is told even if
that device never comes back online, and a contact with a channel to
only one of our devices is told by that one. Siblings are not sent
revokes: `device.retired` reaches them by sync, and a retired device's
keys are dead to them by the fold (`vault-events.md` §7.3).

### 4.3 Challenges

**Answering.** A device answers every `devices/1.0` challenge it can
open (`devices-protocol.md` §5), automatically, whenever it is
unlocked — a device that is retired in its own vault included. **A
device that learns it is retired** — `device.retired` naming `self`
arrives by sync — shows it and does two things at once: it stops every
automatic act (no sending, no vouching, no revoking, no sync outward,
no handler side effects) and it **keeps answering challenges**. It
does not wipe itself: if the device that retired it was the stolen
one, this is the honest device, and its answering the challenges is
what tells every contact something is wrong (§7). The person, on this
device, either confirms — the directory is deleted, `device.md` §7 —
or retires the other device from here, which is a mutual revocation
the contacts will show (`devices-protocol.md` §7). A device the person
retires *from itself*, replacing it, revokes its own DIDs toward every
contact before the directory is deleted, and answers nothing after.

**Sending.** Every device of ours that folds a counted revoke from a
contact (`devices-protocol.md` §7) and finds no challenge sent yet by
any of its siblings — a `message.out` with the challenge's `msgType`
on a channel under the end's key, visible after sync — sends one; two
devices sending two, apart, is two answers folded to one
(`devices-protocol.md` §8). Whether a device sends challenges at all,
or leaves it to a sibling, is that device's option
(`agent/options.json`, `device.md` §5), the same option that governs
the other automatic replies (§4.4).

### 4.4 Acting once

A handler that answers a message — the profile a `user-profile` asks
back, a challenge's response — would answer from every device of ours
that received a copy (`devices-protocol.md` §8). Whether this device
acts on inbound at all is an option of the agent (`agent/options.json`,
`device.md` §5): `act`, default on. The first version accepts that two
devices with it on may answer twice, which the other side folds to one
message; a fold that lets a device see the sibling's answer first is a
sync away and is not relied on. What no device acts on is a word from
a dead end (`devices-protocol.md` §6).

### 4.5 The fold — our devices toward a contact

Added to `vault-events.md` §7.3, per `self` and per contact:

- **our keys toward it**: every `did/<id>` with a live `contact.useKey`
  on the contact, with the `author` of its `did.minted` — which device
  it is — and whether that device is retired; `self`'s own is the one
  `self` writes from, and "none" means mint (§3).
- **vouches owed** (§4.1) and **revokes owed** (§4.2), as defined
  there, each empty once `self` has done its part.
- The outbox drains them as it drains any message: they are
  `message.out`s in the contact's channel, retried until `sent`, held
  after an import like the rest (`vault-events.md` §10) — an imported
  copy's owed vouches are re-derived on the importing device, from its
  own `self`, and sent by it.

## 5. Pairing

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
appends its `device.minted`. It then takes the invitation: mints a key
for the purpose, writes its first message to the invitation's DID, and
attaches the channel:

```jsonc
{ "type": "contact.created",  "data": { "cid": "0199…" } }
{ "type": "contact.attached", "data": { "cid": "0199…", "myKey": "did/019a…", "peerKey": "q4w8…", "because": "paired" } }
```

`because: paired` is the fourth value beside `invitation`, `accepted`
and `manual` (`vault-events.md` §6): this channel is to a device of
ours. The inviting device, on the person's accept there, does the
same — its own `contact.created`, its own `contact.attached { because:
paired }` on the pair the envelope proved. Two contacts, one on each
device, both `paired`: after the first sync they are one (§6).

Pairing is by hand on both ends, as accepting a contact is, and is the
one place a device is introduced by a person rather than by the vault:
before the sync that follows, neither device has evidence of the other
beyond the invitation the person carried across. From then on the
evidence is the vault's.

## 6. The self contact

Every contact with a live `contact.attached { because: paired }` is a
member of the **self contact**, and so is every channel whose peer key
a `peer.resolved` joins to a DID that one of our own `did.minted`
records (`vault-events.md` §5) — the fold knows our own DIDs and needs
no vouch to recognise a sibling's key. All of them fold to one
component, the identity's own, with no `contact.merged`; the
application lists it as "your devices", not among contacts, and its
thread is not a conversation. Its ends are our devices, one per
sibling that has a key toward us, and their liveness is not
`devices-protocol.md` §7's: a sibling's chain is live iff the device
that minted its key is not retired (`vault-events.md` §7.3) — the
vault says, and no vouch, revoke or verdict is exchanged among
siblings. A channel attached `paired` whose peer DID turns out, after
sync, to be no key of ours is shown as what it is: a stranger the
person paired with, to be detached.

A sibling that a device learns of by sync before any channel exists —
a `device.minted` and `did.minted`s from an `author` it has no channel
to — is reached as a contact is: the device mints a key toward the
self contact (§3) and writes to the sibling's key toward self; the
sibling's fold attributes the stranger channel to self by the DID,
which it holds by then or will after its next sync from whoever paired
the newcomer. So a device pairs with one sibling and meets the rest
without the person's hand: the third device of an identity pairs with
either of the two.

What the siblings then exchange over these channels is `sync.md`.

## 7. Lifecycles

**A second device.** The person, on phone A, issues a pairing
invitation; exports a snapshot; restores it on laptop B, which is born
and appends `device.minted`; B takes the invitation, attaches `paired`;
A accepts, attaches `paired`. Sync starts. B, seeing contacts it has no
key toward, mints one per contact and `contact.useKey`s them; A,
seeing B's keys by sync, owes a vouch per contact and sends them. Each
contact folds the vouch, gains a second live end, and from its next
message on seals to both. B is now reached by everyone A is, and A by
everyone B will meet.

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

## 8. Versioning, open

- **Version.** The events here are additions within vault version 3
  (`vault-folder.md` §10): an older reader carries them unread and
  folds a contact to the one end it knew. The protocols are their own
  (`devices-protocol.md` §10, `sync.md` §4).
- **Vouches by a compromised device**, the identity's side. What a
  `since` on a revoke (`devices-protocol.md` §10) needs of us is to
  know which device introduced which — for a sibling that arrived by
  sync, the sibling whose message carried its `device.minted`
  (`vault-events.md` §11) — which sync does not yet record.
- **A pool of keys** (§3): a device pre-minting keys and writing
  their public halves to the vault, so that a sibling meeting a new
  contact can vouch for the newcomer's key in the same breath and no
  sync is needed before the contact reaches every device. The lazy
  form is the first version.
- **Acting once.** The `act` option (§4.4) is the first version's
  whole answer to two devices answering twice. A device that waits one
  sync before acting, or a fold that assigns the answer to one device,
  is the next.
- **The self contact's channels** carry sync and nothing else; whether
  a person's note to themself across devices is a message in it, or
  an event of its own, is not decided.
- **Remote wipe** is not possible and is not promised: a retired
  device that cooperates deletes itself (§4.3), and one that does not
  is what the challenge exists for (`devices-protocol.md` §5).
