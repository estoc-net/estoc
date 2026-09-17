# Deferred design notes

These drafts are outside the [phase-1 contract](../README.md). They are retained
as design material, not implementation requirements or commitments to a later
interface. They reserve no current event types, payload fields, failure codes,
key names, extension APIs or test cases. Their candidate rules may be incompatible
with the current profile; they must be reconsidered before a feature is adopted.

| Topic | Candidate draft | Decisions still needed before implementation |
| --- | --- | --- |
| Mutable channel DIDs | [Web channel DIDs](did-web-channels.md) | Current-document authorization, lookup/retry limits, proof recovery and any new failure model |
| Multiple receiving replicas | [Replica mediation](replica-mediation.md) | Replica lifecycle, fan-out, recipient control and automatic-execution coordination |
| Remote vault synchronization | [Vault sync](vault-sync.md) | Remote recovery, encrypted transfer, reset/erasure and integration with portable import |

Phase 1 implements immutable `did:peer:4` application channels, one active
writable runtime, ordinary account-scoped pickup and portable SQLite recovery.
Mediator and routing-service DID resolution remains independent of the channel
method restriction. These drafts will be revisited when their features are
adopted, together with the owning specifications and conformance cases.
