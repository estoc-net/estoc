# Changelog

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
  first reply — and the mechanism every later rotation will ride.
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
