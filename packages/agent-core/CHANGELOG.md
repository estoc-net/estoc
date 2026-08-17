# Changelog

## 0.9.0 — 2026-08-17

- **The chat projection leaves the library.** `chatView`, `ChatMessage`
  and `Agent.history()` are gone: agent-core hands out log records and
  says which contact they belong to; what a record looks like on screen
  (which types show, what "content" is, sent/received wording) is the
  application's projection, not the protocol layer's. `onMessage` is now
  `(record: MessageRecord, contact: ContactRecord | null)` — the contact
  the record is homed to through the DID histories, null for an anonymous
  envelope or a DID no contact has used (the attribution rule stays here:
  the plaintext `from` is never consulted). It fires for every appended
  record, anonymous ones included. `sendBasicMessage` resolves to the
  appended `MessageRecord`. New `counterpartyOf(record)`: the proven sender
  for inbound, the addressee for outbound, null for anonymous mail. Read the
  log with `vault.messages.read()` and project it yourself — the app's copy
  of the old projection is `app/src/core/chat.ts`.

## 0.8.0 — 2026-08-16

- **Changing mediator = rotating every DID.** `Vault.setMediator` and
  `Agent.setMediator` now accept a vault that already has one (the same
  mediator again is refused). The agent asks the old mediator to drop every
  DID it knew us by, withdraws open invitations (`onInvitation` for each),
  and the vault records the move: a fresh mediator-facing key named
  `mediator/<n>` (`mediationKeyName`, `mediationGeneration`), and the
  retired public DID written as the closed first `myDids[]` entry of every
  contact who wrote to it and was never answered. `start` then mediates
  anew (public key `public/<n>`), and enforces an invariant checked at
  every start: a current DID toward a contact whose service is not the
  current routing DID is closed for a fresh one (`rotateStale`) — so a
  move interrupted by a crash completes at the next start. Contacts we
  have introduced ourselves to are sent a trust-ping/2.0 `ping`
  (`response_requested: false`) from the new DID with `from_prior`
  attached; inbound pings from a known contact are acknowledged (and
  answered with `ping-response` when asked), a stranger's ignored, neither
  logged. `from_prior`'s prior is now `addressedAs`, else the DID of ours
  they were last written to from (`previousMyDid`), else the public one
  (never for an invitation contact) — so a rotation before any reply still
  vouches with the DID they know. Every DID in a contact's `myDids[]` —
  retired public ones included — is re-derived on start. Closing the socket
  on purpose (destroy, a move) no longer schedules a reconnect.
- Exports: `TRUST_PING`, `TRUST_PING_RESPONSE`, `previousMyDid`,
  `mediationKeyName`, `mediationGeneration`.

## 0.7.0 — 2026-08-15

- **Single-use invitations** (out-of-band/2.0). `Agent.createInvitation
  (goal?)` mints a did:peer:4 for whoever answers first — keystore key
  `invite/<id>`, service = the mediator's routing DID, registered with the
  mediator (a registration that failed is retried at the next start; the
  call throws so the URL is not handed out unusable) — and records it under
  `invitations/<id>.json` (`InvitationStore`, `Vault.invitations`,
  `Vault.createInvitation`). `invitationMessage(record)` /
  `Agent.invitationMessage` is the OOB plaintext (`goal_code: connect`,
  `goal` defaults to "Write to <name>", `accept: didcomm/v2`);
  `invitationUrl(base, message)` puts it in `?_oob=`; `parseInvitation
  (input)` reads a URL, the bare parameter, or the JSON back (and
  `resolveMediatorInput` now uses it). `Agent.acceptInvitation(input,
  petname)` adds the contact by the DID inside (`ContactRecord.invitation`
  = its id; our own and a mediator's are refused) and introduces us at
  once from a DID minted for them, `pthid` naming the invitation on our
  messages out until the introduction is done. Inbound, the first envelope
  sealed to an invitation's DID takes it: the DID moves into that
  contact's `myDids[]` (key name kept), the record is marked
  `acceptedBy`/`acceptedAt`, `addressedAs` is set so no `from_prior` is
  owed, and later mail from anyone else to it is dropped. A contact met
  through their invitation is never sent `from_prior` either — no public
  DID was involved. `Agent.invitations()`, `Agent.revokeInvitation(id)`
  (open ones only; the mediator is asked to drop the DID), new event
  `onInvitation`. Snapshots carry `invitations/`; import adds missing ones
  and marks taken what the snapshot saw taken (`ImportOutcome.
  invitationsAdded`).
- Exports: `INVITATIONS_DIR`, `KEY_INVITE_PREFIX`, `isRelationshipKey`,
  `InvitationStore`, `isOpenInvitation`, `parseInvitationRecord`,
  `InvitationRecord`, `GOAL_CONNECT`, `Invitation`. Internally every
  relationship DID (pairwise or invitation) is re-derived on start and
  registered when pending.

## 0.6.0 — 2026-08-15

- **Pairwise DIDs.** The first message to any contact goes out from a
  did:peer:4 minted for that relationship alone — keystore key
  `pair/<cid>/<n>`, service = the mediator's routing DID, registered with
  the mediator as a recipient before use (`Vault.mintPairwise`; the
  contact's `myDids[]` records `{did, key, from, until?, registeredAt?}`
  — `key` replaces the never-written `keyIndex`). The public DID stays,
  as the address strangers write to. A registration the mediator could
  not be told about (offline) is retried on the next send and at every
  start; every DID ever minted is re-derived on start so mail to a
  retired one still opens. `removeContact` asks the mediator to drop the
  DIDs minted toward that contact.
- **Rotation by `from_prior`.** `ContactRecord.addressedAs` remembers the
  DID of ours a contact's latest envelope was sealed to; while it is not
  the DID we write from, every message out carries a `from_prior` JWT
  (the DID they know signing over the one we use), until a reply reaches
  the new DID. Inbound, a verified `from_prior` whose issuer is a contact
  and whose `sub` is the envelope's proven sender moves that contact to
  the new DID (`dids[]` closed + appended with the JWT). This is how a
  stranger who wrote to the public DID gets a DID of their own on our
  first reply — and the mechanism every later rotation will ride. A
  contact who has never written to us is taken to know us by the public
  DID, so the first message from a fresh pairwise DID vouches for itself
  with it; on the receiving side a stranger arriving that way opens with
  the public DID as the closed first entry of their history — pasting that
  business card later finds the same contact instead of making a twin.
- `ChatMessage.contactCid`: the message's contact, resolved through the
  DID histories by `Agent.history()` and `onMessage`, so a thread survives
  its contact changing DIDs. Thread by it, not by `contactDid`.
- `DidcommApi` now needs `FromPrior` alongside `Message` (both didcomm-rust
  builds export it). `currentMyDid`, `KEY_PAIRWISE_PREFIX` exported.

## 0.5.0 — 2026-08-15

- **A mediator is chosen after the identity, not with it.**
  `Vault.create`'s `mediatorDid` is now optional (default: none); a vault
  is an anchor and a seed until `Vault.setMediator(seedKey, did)` names a
  mediator and mints the mediator-facing DID. `Agent.start()` on such a
  vault no longer throws: it reports the new status `{ state: "unmediated" }`
  (history reads, contacts can be added, sending says "no mediator yet"),
  and `Agent.setMediator(did)` names one and starts — mediation, public
  DID, live delivery. Once named, a mediator is not swapped (that would
  re-mint the public DID correspondents hold; rotation with `from_prior`
  is later work).

## 0.4.0 — 2026-08-15

- **Envelopes are no longer captured.** `MessageRecord.layers`,
  `ChatMessage.layers`, the `EnvelopeLayer` type and the `pretty` helper
  are gone: the log keeps the plaintext and the proven sender, not the
  ciphertext that carried it (or the UI prose that described it). Records
  written by earlier versions still parse — the extra field is ignored.
  A see-through view stays where it belongs, in the demo (on 0.2.x).

## 0.3.0 — 2026-08-15

- `snapshotVault` / `importVault` (`vault/transfer.ts`): a vault as a
  path→bytes map, and import with merge semantics — restore into an empty
  backend, merge into the same identity (new log segment, dedup by `mid`
  and by wire message, contacts by `updatedAt`, config/keystore kept),
  refuse a different identity.
- `parseSegment` exported; `ContactStore.put(record, { keepUpdatedAt })`
  for relaying records that carry their own stamp.

## 0.2.0 — 2026-08-15

Hardening after two independent reviews of 0.1.0. No vault format change;
0.1.0 vaults open unchanged.

**Security**

- Inbound attribution is the envelope's alone: an anonymous (anoncrypt)
  envelope no longer falls back to the plaintext `from`. Such mail is logged
  with `sender: null`, projects to no thread, cannot rename a contact, and a
  `request-profile` inside it is not answered.

**Robustness**

- A `request-profile` whose reply path is unreachable is logged and acked
  instead of failing `start()` — one poison message could keep an agent from
  ever coming up.
- Attachments are acked only once dealt with; one that will not open stays
  queued for a later pickup instead of being deleted at the mediator. A
  drain round that acks nothing stops the loop.
- Inbound deliveries are processed one at a time; `MessageLog.append` is
  serialised per instance (OPFS appends in flight together would overwrite
  each other).
- `MessageLog`: the first append after a cut-short line terminates the
  fragment first, so the two never fuse; `read` reports damaged lines via a
  callback and skips them rather than throwing away the history.
- `ContactStore`: `updatedAt` on every `put`; two files with one cid (a
  rename that crashed mid-way) heal on load by `updatedAt`; readers get
  copies, so a field changed without `put` is not half-saved.
- WebSocket: `onopen` failures close the socket into the reconnect path; a
  reconnect drains the queue first, so mail queued during an outage does not
  wait for the next start.
- Dedup keys on `(proven sender, wire id)`, not the id alone.

**Packaging**

- `didcomm` is a peer dependency (types only); inject the build you load.
- `CHANGELOG.md`.

## 0.1.0 — 2026-08-15

First release: agent, `.estoc` vault, `MemoryBackend`, `OpfsBackend`.
