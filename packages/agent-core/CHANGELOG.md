# Changelog

## 0.14.0 — 2026-08-21

public-folder/1.0 (https://didcomm.org/public-folder/1.0), both ends;
the tree/card math is `@estoc/signed-dir` (new dependency), the relay is
the mediator.

- **Owner role on `Agent`**: `publishPublicFolder(files, {expiresInDays?})`
  hashes the folder, signs a root card as the public DID
  (`mediation/<id>/public`, kid `#key-1`), and runs the publish exchange
  against its own mediator — rounds of `publish-result { missing }`
  answered with object attachments (≤ 4 MB inline per round) until the
  `published` receipt. `takedownPublicFolder()` publishes the signed
  `root: null` card; `renewPublicFolder()` re-signs the current root with
  a fresh id and `expires`. Like all mediator transport, none of it
  enters the message log. The folder is the application's projection —
  the agent stores no copy of the tree and none of its objects.
- **Vault**: `state/public-folder.json` (`vault.publicFolder`), the one
  record kept — the current card (compact JWS) and the relay's
  `published` receipt. Carried by snapshots like everything under
  `state/`. The receipt's `retain_until` is required, matching the
  spec (2026-08-22): an absent lease could mean "forever" or "no
  commitment", so a receipt without one is rejected.
- **Renewal at start**: when the card's `expires` or the receipt's
  `retain_until` is within 10 days, the card is re-signed and
  republished (best effort; failure logs and the next start retries).
  Both clocks renew in the one motion, so the "re-send the same card"
  lease refresh the spec also allows is never needed. A card left over
  from a previous mediation is pointed out, never auto-republished —
  the new public DID needs the application's regenerated folder.
- **Reader role, free functions** (`protocol/public-folder.ts`, zero
  vault): `verifyPublicFolder` is the transport-agnostic trust core —
  card signature against the owner's DID document, freshness (stale
  refused by default, `allowStale` for UI), then `resolvePath` hashing
  every hop. `readPublicFolder` reads over the relay's trustless HTTP
  endpoints (`/card/<did>`, `/objects/<cid>`) — the default: zero DIDs,
  zero envelopes. `queryPublicFolder` is the DIDComm form: a one-time
  in-memory did:peer:4 per call (a mailbox, never an identity), answer
  attachments taken inline or fetched from their `links`. The relay is
  discovered from the owner's own DID document (`discoverRelay`) — its
  routing service is the relay.
- Exports: the five message types, `PROBLEM_REPORT`, the IPLD media
  types, `decodeCard`, `authenticationKeyOf`, `httpObjects`, the
  `PublicFolderStore` types, and re-exported `@estoc/signed-dir` shapes
  (`TreeFiles`, `RootCard`, `Resolved`, `DirEntry`).

## 0.13.0 — 2026-08-17

The vault now matches `docs/vault-format.md` (the format contract at the
repository root). No migration from 0.12 vaults: none exist outside the
author's hands.

- **Key names are derivation paths** (`@estoc/keystore` 0.3.0, document
  v3, `estoc/v3/<purpose>/<name>`). `keystore.json` lists no `nextIndex`
  and no `index`; its `keys[]` is a cache, and every mint writes the
  record that names the key (config, `myDids[]`, an invitation) *before*
  the cache entry. `Vault.derive` derives whether or not the cache lists
  the name; `Vault.mintKey` is idempotent. Every derived DID changes.
- **No counters in names.** `mediation/<id>/me` and
  `mediation/<id>/public` replace `mediator`/`public` and their `/<n>`
  generations, where `<id>` is a uuidv7 minted by `Vault.setMediator` and
  recorded as **`config.mediation.id`** (required; a config without it is
  refused). `pair/<cid>/<uuidv7>` replaces `pair/<cid>/<n>`. Gone:
  `KEY_MEDIATOR`, `KEY_PUBLIC`, `mediationGeneration`, the "reuse the key
  a crash left in the index" branches; `mediationKeyName(id, "me" |
  "public")` and `KEY_MEDIATION_PREFIX` are new.
- **A snapshot is the whole `.estoc/` tree** except `cache/` — a
  recursive walk, not an allowlist. `VaultBackend` gains `dirs(dir)`
  (subdirectory names; `MemoryBackend` and `OpfsBackend` implement it),
  and `walk(backend, dir)` is exported. Import merges the keystore's key
  cache by name over the local seed (`keysAdded`), copies any path it has
  no rule for when absent and never overwrites (`filesCopied`), and
  ignores `cache/` on restore too. `STATE_DIR`, `BLOBS_DIR`, `CACHE_DIR`
  name the reserved directories.
- **Log segments are `<uuidv7>.jsonl`**, minted like every other id — no
  more `0001.jsonl` and "highest number plus one" (`nextSegment`,
  `FIRST_SEGMENT`, `segmentNumber` are gone). `orderSegments` keeps only
  `<uuidv7>.jsonl` names and sorts them, which is creation order; a
  writer appends to the newest segment present or mints one (so a session
  after an import carries on behind what came in); `newSegment` and
  `isSegment` are exported. Nothing may read chronology off segment order.
- `parseConfig` keeps fields it does not know, at every level it rewrites.
- **`Vault.verifyAnchor(seedKey)`**: the seed must derive
  `config.identity.anchor.did`; `Agent.start` checks it first, before any
  other key is derived, so a keystore around the wrong seed fails with
  "wrong keystore for this vault" rather than at the first DID it cannot
  open.
- `ContactRecord.updatedAt` is required (`parseContact` refuses a record
  without it); it was always stamped by `put`.
- Merging invitations carries over only `acceptedBy`/`acceptedAt`;
  `registeredAt` is this device's fact about its mediator and stays.

## 0.12.0 — 2026-08-17

- **Contact files are named by cid.** `contacts/<cid>.json` replaces
  `contacts/<petname>.json`: a record has one home for life, so a rename
  is one write in place (no write-then-remove window to heal), two alike
  petnames never collide, and the store keeps no name map. `contactFile
  (cid)` gives the path; `contactFileStem` is gone. No migration: no
  vault outside the author's hands predates this.

## 0.11.0 — 2026-08-17

- **Write first, then deliver: the outbox.** `Agent.send` (and every
  `reply` a handler makes) appends the record to the log and *then* tries
  to deliver it; it resolves to the record once the try has ended, and
  no longer rejects when the network does — a message written offline is
  a message, waiting. What became of each try is an event in a new
  **delivery log** (`.estoc/deliveries/NNNN.jsonl`, `Vault.deliveries`,
  `DeliveryLog`): `{mid, at, status: sent | failed | held, attempt, to?,
  error?}`. `foldDeliveries(events)` gives one `DeliveryState` per `mid`
  (`sent` is final); `deliveryStatusOf(record, states)` says `pending`
  for an outbound record with no event. Undelivered records are tried
  again at every start (after pickup, before the socket), on every socket
  reconnect, and ahead of the next message to the same contact — oldest
  first, stopping per contact at the first failure so nothing overtakes
  — by **`Agent.flush()`** when the application knows the network is
  back before the socket does, and by hand through **`Agent.retry(mid)`**.
  The wire `id` is the
  same on every try; the far side's dedup drops a duplicate. New event
  **`onDelivery(event, record)`**; new option `deliveryTimeoutMs`
  (default 15 s) aborts a POST that hangs so it fails and is retried later.
- **Registration moved into the try.** A pairwise DID is minted when the
  message is composed (offline is fine); the mediator is told about it on
  the first delivery attempt from it, and at every start as before.
- **Import holds what arrives undelivered.** `importVault` appends a
  `held` event for every outbound record it brings in (restore or merge)
  that has no `sent` behind it: not tried unasked, `retry(mid)` sends it.
  Delivery events merge like messages (into a new segment, by
  `(mid, attempt, status)`); another device's `held` does not travel.
  `ImportOutcome` gains `held` (both kinds) and `deliveriesAdded` (merged).
- **`SegmentedLog<T>`** (`vault/log.ts`): the segmented JSONL log
  extracted from `MessageLog`, which is now an instance of it beside
  `DeliveryLog`; `parseSegment` (messages) is unchanged. `DELIVERIES_DIR`
  is exported.
- **A failed start tries again by itself** — `reconnectDelayMs` doubling
  up to a minute, until it comes up or `destroy()` — so an app opened
  offline comes up when the network returns, and drains its outbox then.
  `start()` called from outside cancels the pending retry and goes now.
- **Concurrent sends to a new contact** no longer create the contact,
  mint the DID or send the introduction more than once (per-key turns
  inside the agent).

## 0.10.0 — 2026-08-17

- **Protocols in three layers.** `protocol/types.ts` is split by what
  each protocol is to the agent: `protocol/spec.ts` (what the DIDComm v2
  specification defines — `FORWARD`, `TRUST_PING`, `TRUST_PING_RESPONSE`,
  `OOB_INVITATION`, `isSpecType`) is wired into `Agent`;
  `protocol/mediation.ts` (coordinate-mediation 3.0, messagepickup 3.0) is
  the transport with the mediator; and application protocols go through a
  new handler seam. Every constant is still exported from the package root.
- **The handler seam.** `ProtocolHandler { types, onInbound?, introduce? }`
  and `HandlerContext { vault, send, reply, saveContact, displayName, log }`
  (`protocol/handler.ts`). `basicmessage/2.0` and `user-profile/1.0` are
  now built-in handlers (`basicmessageHandler`, `userProfileHandler`; the
  profile logic — answering `request-profile`, remembering `claimedName`,
  sending ours back on `send_back_yours`, introducing before the first
  message — moved out of `Agent` into `protocol/user-profile.ts`).
  `AgentOptions.handlers` registers more; one naming a built-in's type
  replaces it. A handler runs after the record is logged and `onMessage`
  has fired; a throwing handler is logged, and the message stays handled.
- **`Agent.send(contactDid, type, body, { thid?, pthid?, attachments? })`**
  sends any application-protocol message and resolves to the log record;
  the introduction still precedes the first message to anyone.
  `sendBasicMessage` is a one-line wrapper over it.
- **Everything between contacts is logged, whatever its type.** Before,
  an inbound message of a type the agent did not speak was acked and
  dropped, and pings and profile requests were answered without a trace.
  Now every opened message that is not mediator transport is appended and
  handed to `onMessage` — pings and pongs (in and out, including the pings
  that announce a move), profile requests, and unknown types alike;
  anonymous ones with `sender: null`. Showing them or not is the
  application's projection (the app's `chatView` still yields nothing for
  them). Log lines changed accordingly (`received a <type> message from
  <name>; logged, no handler for it`, `logged an anonymous <type> message;
  it is attributed to nobody`). Trust-ping stays spec-level: a stranger's
  ping is logged but neither answered nor turned into a contact.
- `didPlaceholder` moved to `vault/contacts.ts` (still exported from the
  root); `announcedName` and `shareProfile` are exported.

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
