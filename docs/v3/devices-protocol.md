# devices/1.0 — a contact with several devices — draft

Status: **draft**, 2026-09-02; not implemented. A DIDComm protocol,
`https://estoc.dev/devices/1.0`. Nothing in it depends on the vault:
it is what one party has to do to hold a counterpart that writes from
several devices, and what that counterpart's devices say to it. How an
Estoc device records what it hears is `vault-events.md` (§3.1, §6,
§7.2); which of its devices an Estoc identity introduces and drops,
and how the introducing is done, is `devices.md`; what its devices
exchange among themselves is `sync.md`. Design history:
`research/notes/2026-09-02-per-device-seed-and-agent-split.md` §5–§9.

**The model, in one paragraph.** A contact never sees an identity; it
sees **ends** — the current DIDs of the keys that write to it — and
each end is one device of the counterpart, because every key is one
device's. An identity adds a device by having a device the contact
already knows **vouch** for the new one's key; it drops a device by
having any other device **revoke** its keys, which the contact answers
with a **challenge** to the revoked end; anything a revoked end says
afterwards, the challenge's answer included, is a **conflict** the
contact's person rules on, and nothing else is. A sender writes once
and seals to every live end. The identity's anchor takes no part: no
key of it seals a message here, and a contact is never asked to
resolve one.

## 1. Principles

1. **An end is a device.** What a contact holds of a counterpart is a
   set of keys, each minted by one of the counterpart's devices, each
   wearing a DID; the DIDs a key wore in succession — `from_prior`
   rotations — are a **chain**, and the chain's latest DID is its
   **end**. A contact with three ends of a counterpart has three of
   its devices. Nothing tells a contact *which* device — no device id
   crosses the wire, ever, so that two contacts cannot compare notes
   and find they are talking to one identity.
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
   projection and is resolved by a decision in the contact's own
   record, never reported back. Timeouts are for showing, not for
   deciding: an end that answers late is a conflict, not a corpse.
5. **Send once, seal to every end.** Fan-out is the sender's, at the
   envelope; there is one message, with one id, and a copy per end
   (§8). Mediators do not know and need not.

## 2. Words

- **chain** — the DIDs one key of a counterpart's wore in succession,
  joined by `from_prior` rotations. Every DID is in exactly one chain.
  A chain with two latest DIDs is a fork, a conflict of its own.
- **end** — a chain's latest DID; where a message to that device goes.
- **live / dead / conflict** — a chain's state in the contact's fold
  (§7). Live: written to, its words acted on. Dead: revoked, or ruled
  so; nothing goes to it but a challenge. Conflict: dead, and it
  spoke; shown until ruled.
- **counted** — a vouch or revoke that arrived from a live chain, and
  so took effect (§7). One from a dead chain is a word from a dead
  chain and counts for nothing.

## 3. Vouch

A device the contact knows introduces a sibling's key:

```json
{
  "type": "https://estoc.dev/devices/1.0/vouch",
  "id": "<uuid>",
  "body": { "did": "did:peer:4…" }
}
```

- `body.did` — a DID of the sender's identity the contact may not
  know: the DID of a key another of its devices minted toward this
  contact. One DID per message.
- Sealed authcrypt from the vouching device's key toward the contact,
  like every message; the envelope is the proof that a key the contact
  trusts said it, and no signature inside is required. The message is
  fanned out to every live end of the contact (§8).

The contact records what the envelope proved: an edge from the DID the
sealing key wore (`by`) to `body.did` (`for`), and the message it came
in. Its effect is §7's: a chain that later opens under a key of `for`'s
document is the same counterpart from the moment the contact resolves
it — or before any such channel exists, since the contact may now
write to `for` (§8) and resolve it before sending.

Which devices vouch, and when, is the identity's own affair
(`devices.md` §5.1); what the contact has to allow for is that every
device of the counterpart may vouch for the same key, so that the
introduction does not wait on the one device that happens to be
offline, and that a key vouched for by several is not orphaned when
one of them is lost. Two vouches for one key are two counted edges
and harmless. A key minted toward the contact that it has no channel
under and no vouch for yet is a stranger's until the vouch lands; the
fold unions, so the order in which the new device's first message and
the vouch arrive does not matter beyond what the application shows
meanwhile.

## 4. Revoke

A device that its identity has dropped is revoked toward every contact
by a message from every device that can reach them:

```json
{
  "type": "https://estoc.dev/devices/1.0/revoke",
  "id": "<uuid>",
  "body": { "dids": ["did:peer:4…B1", "did:peer:4…B2"] }
}
```

- `body.dids` — every DID the dropped device's keys wore that this
  contact may know. Naming any DID of a chain kills the whole chain
  (§7); the sender names all it knows so that the contact need not
  have seen the same ones. Never a device id.
- Sealed from the revoking device's key toward the contact; fanned out
  to every live end of the contact (§8). A device may name its own
  DIDs: that is a device leaving, and needs no challenge.

The contact records the edge — the DID the sealing key wore, the DIDs
named, the message — and the effect is §7's: the named chains are
dead, from the moment the observation is folded, and a **challenge**
(§5) is owed to each. A DID named that is not in this counterpart's
chains is ignored — recorded, shown, without effect: a revoke reaches
only the identity it came from.

Every device of the counterpart sends its own revoke, so the contact
is told even if the device that made the decision never comes back
online, and a contact with a channel to only one of the counterpart's
devices is told by that one. Two revokes naming one chain are one
death.

## 5. Challenge and response

A contact that has folded a counted revoke asks the revoked end whether
it is still there:

```json
{
  "type": "https://estoc.dev/devices/1.0/challenge",
  "id": "<uuid>",
  "body": { "by": "did:peer:4…A" }
}
```

- Sent to the revoked chain's end, sealed from a key of the contact's
  that the end's key has a channel with (or a fresh pair, resolved
  before sending). It is the one message a dead end is sent.
- `body.by` — the DID whose revoke this is, so that an honest device
  that answers knows which of its siblings retired it, and its person
  can tell whether that sibling is still theirs.
- Not sent when the revoke named the revoker's own chain (a device
  leaving), nor for a chain the person ruled dead (§6): there is
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
it is unlocked — one that its own identity has dropped included
(`devices.md` §5.3 says why), and one that is wiped or locked cannot.
The answer carries nothing: the envelope is the whole claim, "the key
you were told is dead just sealed this". On the contact's side it is
an inbound message on a dead chain and needs no type of its own in the
fold: it is a word from a dead end (§6), and the chain is in conflict.

**Who challenges.** At least one device of the contact's sends a
challenge for every counted revoke that did not name the revoker's own
chain; which of several does is the contact's own arrangement, and two
sending two, apart, is two answers the answerer's identity folds to
one (§8).

**Timeout.** How long the application shows "checking" before it
shows "gone" is the application's; nothing in the fold changes when it
expires. The chain was dead from the revoke; an answer that comes a
month later is a conflict all the same, which is why a device that is
closed, locked, or offline while the challenge waits loses nothing:
whenever it wakes it answers, and whenever it answers the conflict is
shown.

## 6. A word from a dead end, and the verdict

Every observation on a channel whose chain is dead — a message, a
vouch, a revoke, a rotation, a response — is recorded as it is (an
observation is never refused a home) and does three things and
nothing else: it puts the chain in **conflict**; it is shown, marked;
it is not acted on — no handler runs on it, no reply is sent, no vouch
or revoke or rotation it carries takes effect, and the chain it
extends stays dead. What the person then does is a decision, the
**verdict**, on one chain, named by any DID in it: `live` or `dead`.

- `live` — the person has satisfied themself, off the wire, that this
  is their contact's device: the chain is live again, written to, its
  words acted on from here on. It says nothing about the end that
  revoked it; the person rules on that one too if they mean to, and
  usually does (`devices.md` §8: if the old phone is honest, the one
  that revoked it is not).
- `dead` — the person has decided it is gone: no challenge is sent, its
  words are conflicts. A revoke need not have come first; a person told
  by their contact over the phone that a device is lost may rule it so
  before the counterpart's other devices have said anything.
- A verdict is one more event in the contact's own order: a later
  counted revoke kills a chain ruled live, a later word from a chain
  ruled dead is a conflict again, and a `live` verdict for a chain that
  a sibling later re-vouches changes nothing it did not already say.
- Never sent. The other side is told nothing; what it did with its
  devices is its own business, and what the contact believes is the
  contact's.

An Estoc device records it as `contact.verdict` (`vault-events.md`
§6).

## 7. The contact's fold

The contact holds, per counterpart, a set of chains. Walk what it
observed of the counterpart in its own order, keeping a state per
chain and a set of **named-dead** DIDs:

1. **A chain appears** when the person accepts a channel under one of
   its DIDs — it is **live**; or when a counted vouch names one of its
   DIDs — it joins the counterpart, **live** unless one of its DIDs is
   named-dead, then **dead**; through nothing else. A channel a
   stranger opened belongs to no counterpart until a vouch or an
   accept brings it in.
2. **A revoke from a live chain** is counted. Every chain that
   contains a named DID is **dead**, its `revokedBy` the revoking
   chain; a named DID no chain contains yet is added to named-dead,
   so the chain that later contains it is dead on arrival. Named DIDs
   outside the counterpart are ignored. A revoke that names its own
   chain is that chain's own leaving: dead, and no challenge is owed.
3. **A vouch from a live chain** is counted: the edge stands, and
   stands after the vouching chain's death. The chain vouched for is
   live or dead by rule 1.
4. **A rotation from a live chain** extends it.
5. **Any observation on a dead chain** — rules 2 to 4 not applied, a
   message, a response — sets the chain to **conflict**, and is
   recorded with it. Nothing it carries is an edge or a kill.
6. **A verdict** sets the chain it names to **live** or **dead**,
   clearing `revokedBy` and the conflict; later events apply to the
   new state.

What the fold reports, per chain:

```ts
type End = {
  did: string;                            // the chain's end
  chain: string[];                        // its DIDs, oldest first
  state: "live" | "dead" | "conflict";
  vouchedBy: string[];                    // the `by` of every counted vouch for it; [] for an accepted chain
  revokedBy: string | null;               // the end of the chain that revoked it, when a revoke did
  challenged: boolean;                    // some device of the contact's sent a challenge to it
  words: string[];                        // what it said while dead, in order
};
```

- `ends[]`: one per chain, in order of first appearance. Several ends
  are several devices; a *fork* — one chain with two latest DIDs — is
  a conflict within one end.
- The **write set** is every live end: a message to the counterpart
  goes to all of them (§8). Empty for a counterpart with no live end —
  the person is told, and the conflicts (if any) are where the answer
  is.
- **Challenges owed**: every end that is `dead` by a counted revoke
  that was not its own, has no verdict, and is not `challenged`.
- Every inbound message says which end sent it — the DID the sealing
  key wore — so the application can show the counterpart's devices,
  and beside each message which one, without a name for any of them.

A contact that itself has several devices folds this on each from its
own observations and unions them: both may see the same vouch, arrived
on each's own channel, as two counted edges; both may challenge; the
last verdict wins. None of it needs a rule beyond the contact's own
order.

## 8. Sending to many ends

A message to a counterpart is written once and goes to every live end:

- One plaintext, with one `id`; its `to` names every end it goes to.
  One **copy per end**, each sealed to its end, each delivered on its
  own to that end's routing. The plaintext is the same in every copy.
- **The receiver folds copies by id.** Copies of one message that
  reached the receiver on several of its own devices — the sender
  sealed to several keys of the receiver's, one per device — are one
  message, with one id; so are the copies of one outbound to several
  ends, on the sender's side. The id is the sender's claim and is
  never a storage identity; the copies keep their own.
- **Inbound, on each of the receiver's devices.** A counterpart fans
  out to the receiver's ends the same way; each of the receiver's
  devices receives its own copy. A device that was never reached — the
  counterpart did not have its end yet — reads the message from a
  sibling's copy, which is what the receiver's own sync is for.
- **A message from an end the receiver does not know** — a device of
  the counterpart's that the counterpart has not yet had vouched for —
  is a stranger's until the vouch lands (§3). A message from a dead
  end is §6.
- **Side effects, once.** A handler that answers a message — a profile
  asked back, a challenge's response — would answer from every device
  of the receiver's that got a copy. This protocol accepts that: two
  answers with one id are one message to the party that folds them,
  and which of its devices answers is the receiver's own arrangement
  (`devices.md` §5.4). What no device acts on is a word from a dead
  end (§6).

The counterpart's mediators are told nothing new: each copy is a
forward to the routing of the end it goes to, as a single-device
message was. A counterpart whose devices share a mediator gets N
forwards to one service; that mediator sees N envelopes to N recipient
keys, as it would from N different senders.

## 9. What a contact can see

Each contact sees how many ends of a counterpart it holds, when each
appeared and was vouched for, and when one was revoked and by which;
it sees which end each message came from. It sees no device id, no
label, no key name and no sibling's DID toward anyone else, and two
contacts comparing what they see find only that each holds N chains of
an identity — the same N, changing at the same moments, which is the
one correlation this design accepts, as it accepts that a contact sees
which mediator each device uses. Nothing here changes what the
mediators see: N recipients where there was one, each registered by
its own device, each forwarded to on its own.

## 10. Versioning, open

- **Version.** `devices/1.0` is a DIDComm protocol and versions as
  such. A message of an unknown type in it is answered with a problem
  report, as any unknown type is.
- **A contact that does not speak `devices/1.0`** folds no vouch: the
  counterpart's other devices are strangers to it and stay so. Toward
  such a contact the counterpart is one device — whichever it attached
  — and a change of device is what it was before this protocol: a
  `from_prior` rotation from the device it knows to the one replacing
  it, a replacement, not an addition, done by the old device while it
  still can. The problem report for an unknown type is what tells the
  vouching device so.
- **A signed vouch.** The envelope is the proof (§3) and the contact's
  own fold the only reader; a JWS inside — the shape `from_prior` has
  — would let a third party check it, and is what a vouch by a key
  that never seals an envelope (a pre-committed successor to a lost
  identity, `devices.md` §8) will need. Add it then, as an optional
  `proof` on `vouch` and `revoke`.
- **Vouches by a compromised device.** A vouch is a fact (§1
  principle 2): a device that was stolen and, before it was dropped,
  vouched a stranger's key toward a contact has planted an end the
  revoke does not name, unless the identity's other devices learnt of
  it and dropped it too. Bounding the damage — a `since` on the revoke
  after which the named chains' vouches do not count, matched against
  the contact's own observation times; or the contact's application
  marking an end whose every voucher has since been revoked — is not
  in this version, and neither is a primary device that alone may
  vouch, which is how the services that share this model close the
  hole. What a `since` needs of the identity's side is `devices.md`
  §9.
- **Timeouts** are the application's throughout (§5): nothing in the
  fold expires.
