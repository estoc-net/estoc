# @estoc/agent-core

The DIDComm v2 agent behind Estoc's clients, over an `.estoc` vault:
`@estoc/event-store` holds it, `@estoc/vault` says what its events mean,
and this package is what runs on it — mediation (coordinate-mediation
3.0), pickup and live delivery (messagepickup 3.0 over HTTP and
WebSocket), routing 2.0 forwards, channels of did:peer:4 pairs rotated
by `from_prior`, invitations, trust-ping, basicmessage and user-profile.
The rules are the [replica model](../../docs/replica-model/README.md)'s
[channels](../../docs/replica-model/channels.md) and
[distributed delivery](../../docs/replica-model/distributed-delivery.md).

Runs wherever didcomm-rust's WASM does: the browser (Vite), workerd, Node.
The WASM itself is *not* loaded here — see [Didcomm API](#didcomm-api).

## Layers

```
Agent            a vault running: one receiver, one dispatcher, a line to each mediator; open recovers and sends nothing
  ├─ identity    the SQLite runtime opened with the seed's keys: createVault · openVault · inspectRuntime · inspectSnapshot
  ├─ mediation   an arrangement recorded before the mediator is asked, granted, its recipients reconciled on every connection
  ├─ dids        routes, communication DIDs minted from their ID and route alone, disclosure, invitations, retirement
  ├─ send        what a message is, committed as an intent in its channel before any network work
  ├─ prepare     an intent → the one exact envelope every transport call of it carries
  ├─ dispatch    the one transport call of a prepared package, under a live action; dispatcher waits for prerequisites
  ├─ receive/    the gate before the vault, the receipt as one observation admitted or not before its lock is released, and what a receipt owes afterwards
  ├─ effects     what an established input earns on its own: the receipt it asks for, a handler's reply
  ├─ handlers/   trust-ping 2.0 · basicmessage 2.0 · user-profile 1.0 · report-problem 2.0 · empty 1.0, through the handler seam
  ├─ rotate      a local rotation frozen with its proof; privacy: a disclosed address gives way to a private successor
  ├─ records     what an application is shown, as plain JSON; views: reading them, and the manual steps they name
  ├─ link        the line to a mediator: sealing to it, opening what it sends, HTTP and the socket; pickup rides it
  ├─ keyring     the keys this runtime holds in hand, derived by name and checked against what the vault recorded
  ├─ trace       what this runtime observed, in the runtime's local state — never a fact of the vault
  └─ protocol/   message types and shapes as the specifications have them; nothing here reads a vault
```

A message is decided over the fold read under the vault's writer lock
and committed as an intent, then as a package, before its one transport
call. That call is made under a live action: the user's send, the input
a live receipt answered, or an explicit manual step. Opening, importing
or restoring a vault mints none, so whatever such a runtime finds
waiting is shown as pending work, each item naming the manual procedure
(`agent.manual`) that completes it.

An inbound envelope is opened with the one key of this vault it names,
its sender read from what the vault already holds and never from the
network, and recorded as an observation with its rotation proof as it
came. Before the receipt's lock is released, the vault's ordered
admission pass decides, among every observation still owed one in
first-receipt order, whether this one is admitted for application use,
so that the writer lock is the one sequence every receipt and
admission goes through whichever way the delivery came. Whether the
proof verifies, which channel the input is established in and what it
earns are the fold's to say, over the admitted observations alone.

## Usage

```ts
import { Agent, AgentTrace, createVault, openVault } from "@estoc/agent-core";
import { openNodeSqlite } from "@estoc/event-store/node";
```

The host opens the SQLite driver — `openNodeSqlite` on Node,
`openSqlitePool` from `@estoc/event-store/browser` in a Worker — and
hands it to `createVault` or `openVault`, which return the runtime and
the seed's `Keys`. `Agent.open(vault, options)` runs the agent with
networking off; `Agent.start` also connects every mediation the vault
must keep receiving on. `@estoc/daemon` is the host most programs want:
it does this wiring and serves records and procedures over RPC.

## Didcomm API

The agent takes `{ Message }` from whichever didcomm-rust build your
runtime loads — `@estoc/didcomm` (browser/workerd WASM, instantiated
your way) or `@estoc/didcomm-node`. Both export the same class. This
package refuses to know how the WASM is instantiated, because every bundler
and runtime does it differently.

The Estoc builds are didcomm-rust with one option added: `unpack` can leave
a `from_prior` header unverified, so that a rotation proof whose issuer is
out of reach does not stop the message it rides from being received. The
agent opens inbound envelopes that way and has the vault judge the proof
from the evidence it records; the upstream builds cannot open them so, and
`unpack` refuses one. `unpack` also holds the layers to one sender:
the plaintext's `from` and any signature inside must be the sealer's, and
an authenticated layer wrapped in an anonymous one is refused, since the
binding reports only the outer layer's recipients. The mediator link still
verifies the proof at unpack.

`@estoc/didcomm` is a peer dependency for its types only; install the build
you inject.

`fetch` and `WebSocket` are injectable too; the tests run two agents
against an in-process fake mediator that way (`test/fake-mediator.ts`).

## Development

```
pnpm test       # vitest: every module against an in-process fake mediator, and test/e2e/ over file vaults
pnpm build      # tsc → dist/
```

## License

Apache-2.0
