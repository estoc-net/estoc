import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveDIDCommDoc } from "@estoc/did-peer";
import { openNodeSqlite } from "@estoc/event-store/node";
import { SqliteVault, exportVault, importVault, openPortable, parseStrict, restoreVault, type Imported } from "@estoc/event-store/v3";
import { Keys, scanVault, vaultHeldRoots, vaultRetention, type Channel, type Did, type DidId, type VaultFold } from "@estoc/vault/v3";

import { PLAIN_TYP, packEncrypted, secretsResolverFor, type IMessage } from "../../../src/protocol/didcomm.js";
import { FORWARD } from "../../../src/protocol/spec.js";
import { Agent, AgentTrace, openVault, type AgentOptions, type Inbound, type OpenedVault } from "../../../src/v3/index.js";
import { MEDIATOR_HTTP, type FakeMediator } from "../../fake-mediator.js";
import { afterNextCommit, didcomm, mediatedParty, until as untilWithin, type MediatedParty } from "../helpers.js";

/**
 * Where the process of a running party dies: `prepared` once its next
 * package is recorded, before any transport call is made for it;
 * `unsent` inside its next forward, which the mediator never takes;
 * `unrecorded` once the mediator has queued that forward and before
 * the caller hears so.
 */
export type Death = "prepared" | "unsent" | "unrecorded";

/** A party whose vault is a file, run by an agent over a transport the test can refuse or cut. */
export interface Running {
  party: MediatedParty;
  /** the runtime and keys of the process now running: other ones after a restart */
  runtime: OpenedVault["runtime"];
  keys: Keys;
  agent: Agent;
  /** every delivery the agents of this party were told of, across restarts */
  inbounds: Inbound[];
  log: string[];
  /** every call the processes of this party made to the transport, reaching the mediator or not */
  calls: number;
  /** the next call to the mediator is answered 503 instead of reaching it */
  refuseNext: { armed: boolean };
  /** the next forward is answered 503 instead of reaching the mediator, whatever else is called before it */
  refuseForward: { armed: boolean };
  /** the process died: nothing of it calls the transport again, though its runtime may still be closing */
  dead: boolean;
}

/** One process of a party: what its transport answers to, and its end once that began. */
interface Life {
  death: Death | null;
  ended: Promise<void> | null;
}

interface Started extends Running {
  file: string;
  options: Partial<AgentOptions>;
  life: Life;
}

/** What is waited for here is a whole receipt with everything that follows it: several commits and transport calls, each step folding the vault anew, on a machine that may be busy with other suites. */
export const until = (what: string, condition: () => boolean): Promise<void> => untilWithin(what, condition, 60_000);

/** The timeout of a scenario of many round trips, each one a second or two of folding where nothing else runs. */
export const LONG = 300_000;

export const foldOf = ({ runtime, keys }: Pick<Running, "runtime" | "keys">): Promise<VaultFold> => scanVault(runtime.vault, keys);

export const channelOf = (local: Did, peer: Did): Channel => ({ localDid: local, peerDid: peer });

const started: Started[] = [];
const directories: string[] = [];

/** The process closed, once: the work its runtime had admitted finishes first, and only then is the file free. */
function end(self: Started): Promise<void> {
  const { agent, runtime } = self;
  self.life.ended ??= (async () => {
    agent.close();
    await runtime.close();
  })();
  return self.life.ended;
}

const gone = (): Error => new Error("the process is gone");

function die(self: Started, life: Life): Error {
  if (self.life === life) {
    self.dead = true;
    end(self).catch(() => undefined);
  }
  return gone();
}

export function dieAt(running: Running, death: Death): void {
  const self = running as Started;
  const { life } = self;
  if (death === "prepared") {
    afterNextCommit(self.runtime, "message.prepared", () => {
      throw die(self, life);
    });
    return;
  }
  life.death = death;
}

/** The transport of one process: a death armed for it is met by its own forward alone, whatever else the mediator handles meanwhile. */
function transportOf(mediator: FakeMediator, self: () => Started, life: Life): typeof globalThis.fetch {
  return async (input, init) => {
    const party = self();
    party.calls++;
    const mine = (life.death !== null || party.refuseForward.armed) && (await mediator.typeOf(String(init?.body))) === FORWARD;
    if (life.ended !== null) throw gone();
    if (party.refuseNext.armed || (mine && party.refuseForward.armed)) {
      party.refuseNext.armed = false;
      if (mine) party.refuseForward.armed = false;
      return new Response(null, { status: 503 });
    }
    const death = life.death;
    if (!mine || death === null) return mediator.fetch(input, init);
    life.death = null;
    if (death === "unrecorded") await mediator.fetch(input, init);
    throw die(party, life);
  };
}

async function agentOver(mediator: FakeMediator, self: () => Started, life: Life, vault: Pick<OpenedVault, "runtime" | "keys">, trace: AgentTrace, options: Partial<AgentOptions>): Promise<Agent> {
  return Agent.start(vault, {
    didcomm,
    fetch: transportOf(mediator, self, life),
    WebSocket: mediator.WebSocket,
    trace,
    onInbound: (inbound) => self().inbounds.push(inbound),
    log: (line) => self().log.push(line),
    ...options,
  });
}

async function freshFile(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "estoc-e2e-"));
  directories.push(directory);
  return path.join(directory, name);
}

/** A party of `mediator` with one communication DID, its vault in a file of its own, and its agent started. */
export async function run(mediator: FakeMediator, fill: number, didId: DidId, options: Partial<AgentOptions> = {}): Promise<Running> {
  const file = await freshFile("vault.sqlite");
  const party = await mediatedParty(mediator, fill, didId, openNodeSqlite(file, { mode: "create" }));
  const life: Life = { death: null, ended: null };
  const self: Started = { party, runtime: party.runtime, keys: party.keys, agent: undefined as unknown as Agent, inbounds: [], log: [], calls: 0, refuseNext: { armed: false }, refuseForward: { armed: false }, dead: false, file, options, life };
  started.push(self);
  self.agent = await agentOver(mediator, () => self, life, party, party.trace, options);
  return self;
}

/** The party's process ended, if it still runs, and another started over the same file once the first has let go of it: nothing but the file is carried over. */
export async function restart(running: Running, options: Partial<AgentOptions> = {}): Promise<void> {
  const self = running as Started;
  await end(self);
  const vault = await openVault(openNodeSqlite(self.file, { mode: "readwrite" }), self.party.seedKey);
  const life: Life = { death: null, ended: null };
  self.runtime = vault.runtime;
  self.keys = vault.keys;
  self.life = life;
  self.dead = false;
  self.agent = await agentOver(self.party.mediator, () => self, life, vault, await AgentTrace.open(vault.runtime.local), { ...self.options, ...options });
}

export async function stop(running: Running): Promise<void> {
  await end(running as Started);
}

/** The party's vault as it stands, exported to a snapshot file. */
export async function snapshotOf(running: Running): Promise<string> {
  const file = await freshFile("snapshot.sqlite");
  await exportVault(running.runtime, (mode) => openNodeSqlite(file, { mode }), { heldRoots: vaultHeldRoots(running.keys) });
  return file;
}

/**
 * The party on another machine: `snapshot` restored under the same
 * seed into a runtime of its own, and an agent started over it. It
 * speaks to the mediator as the same account, so the process it was
 * taken from is stopped first unless the two are to run side by side.
 */
export async function restoredFrom(running: Running, snapshot: string, options: Partial<AgentOptions> = {}): Promise<Running> {
  const { party } = running;
  const file = await freshFile("vault.sqlite");
  const source = openPortable(openNodeSqlite(snapshot, { mode: "readonly" }));
  let runtime: SqliteVault;
  try {
    const restored = await restoreVault(source, (mode) => openNodeSqlite(file, { mode }), { heldRoots: vaultHeldRoots(null), anchor: await Keys.anchorOf(party.seedKey) });
    runtime = new SqliteVault(restored.runtime);
  } finally {
    source.close();
  }
  const keys = await Keys.open(party.seedKey, runtime.metadata.anchor);
  const life: Life = { death: null, ended: null };
  const self: Started = { party, runtime, keys, agent: undefined as unknown as Agent, inbounds: [], log: [], calls: 0, refuseNext: { armed: false }, refuseForward: { armed: false }, dead: false, file, options, life };
  started.push(self);
  self.agent = await agentOver(party.mediator, () => self, life, { runtime, keys }, await AgentTrace.open(runtime.local), options);
  return self;
}

export async function imported(running: Running, snapshot: string): Promise<Imported> {
  const source = openPortable(openNodeSqlite(snapshot, { mode: "readonly" }));
  try {
    return await importVault(running.runtime, source, { retainedRoots: vaultRetention(running.keys) });
  } finally {
    source.close();
  }
}

/** An envelope anyone sealed, handed to the mediator for `next` as a sender's agent would hand it. */
export async function forwarded(mediator: FakeMediator, next: Did, envelope: string): Promise<void> {
  const message = { id: crypto.randomUUID(), typ: PLAIN_TYP, type: FORWARD, to: [mediator.did], body: { next }, attachments: [{ media_type: "application/didcomm-encrypted+json", data: { json: parseStrict(envelope) } }] } as unknown as IMessage;
  const [packed] = await packEncrypted(didcomm, message, mediator.did, null, null, { resolve: resolveDIDCommDoc }, secretsResolverFor([]), { forward: false });
  const answer = await mediator.fetch(MEDIATOR_HTTP, { method: "POST", headers: { "content-type": "application/didcomm-encrypted+json" }, body: packed });
  if (!answer.ok) throw new Error(`the mediator answered the forward ${answer.status}`);
}

export async function stopAll(): Promise<void> {
  await Promise.all(started.splice(0).map(end));
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
}
