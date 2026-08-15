# Changelog

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
