import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { openNodeSqlite } from "@estoc/event-store/node";
import { scanVault, type Channel, type Did, type DidId, type Keys, type VaultFold } from "@estoc/vault/v3";

import { FORWARD } from "../../../src/protocol/spec.js";
import { Agent, AgentTrace, openVault, type AgentOptions, type Inbound, type OpenedVault } from "../../../src/v3/index.js";
import type { FakeMediator } from "../../fake-mediator.js";
import { didcomm, mediatedParty, until as untilWithin, type MediatedParty } from "../helpers.js";

/**
 * How the process of a running party dies at its next forward: `unsent`
 * before the mediator takes the message, `unrecorded` once the mediator
 * has queued it and before the caller hears so.
 */
export type Death = "unsent" | "unrecorded";

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
  /** the next call to the mediator is answered 503 instead of reaching it */
  refuseNext: { armed: boolean };
  /** armed, the process dies at its next forward: its agent and runtime closed, that call and every later one failing */
  die: { at: Death | null };
  dead: boolean;
}

interface Started extends Running {
  file: string;
  options: Partial<AgentOptions>;
}

/** What is waited for here is a whole receipt with everything that follows it: several commits and transport calls, each step folding the vault anew, on a machine that may be busy with other suites. */
export const until = (what: string, condition: () => boolean): Promise<void> => untilWithin(what, condition, 60_000);

/** The timeout of a scenario of many round trips, each one a second or two of folding where nothing else runs. */
export const LONG = 300_000;

export const foldOf = ({ runtime, keys }: Pick<Running, "runtime" | "keys">): Promise<VaultFold> => scanVault(runtime.vault, keys);

export const channelOf = (local: Did, peer: Did): Channel => ({ localDid: local, peerDid: peer });

const started: Started[] = [];
const directories: string[] = [];

function transportOf(mediator: FakeMediator, running: () => Started): typeof globalThis.fetch {
  return async (input, init) => {
    const self = running();
    if (self.dead) throw new Error("the process is gone");
    if (self.refuseNext.armed) {
      self.refuseNext.armed = false;
      return new Response(null, { status: 503 });
    }
    const death = self.die.at;
    if (death === null) return mediator.fetch(input, init);
    const seen = mediator.seenTypes.length;
    const intercept = mediator.intercept;
    if (death === "unsent") mediator.intercept = (msg, from) => (msg.type === FORWARD ? null : intercept?.(msg, from));
    const response = await mediator.fetch(input, init).finally(() => (mediator.intercept = intercept));
    if (!mediator.seenTypes.slice(seen).includes(FORWARD)) return response;
    self.die.at = null;
    self.dead = true;
    self.agent.close();
    await self.runtime.close();
    throw new Error("the process is gone");
  };
}

async function agentOver(mediator: FakeMediator, self: () => Started, vault: Pick<OpenedVault, "runtime" | "keys">, trace: AgentTrace, options: Partial<AgentOptions>): Promise<Agent> {
  return Agent.start(vault, {
    didcomm,
    fetch: transportOf(mediator, self),
    WebSocket: mediator.WebSocket,
    trace,
    onInbound: (inbound) => self().inbounds.push(inbound),
    log: (line) => self().log.push(line),
    ...options,
  });
}

/** A party of `mediator` with one communication DID, its vault in a file of its own, and its agent started. */
export async function run(mediator: FakeMediator, fill: number, didId: DidId, options: Partial<AgentOptions> = {}): Promise<Running> {
  const directory = await mkdtemp(path.join(tmpdir(), "estoc-e2e-"));
  directories.push(directory);
  const file = path.join(directory, "vault.sqlite");
  const party = await mediatedParty(mediator, fill, didId, openNodeSqlite(file, { mode: "create" }));
  const self: Started = { party, runtime: party.runtime, keys: party.keys, agent: undefined as unknown as Agent, inbounds: [], log: [], refuseNext: { armed: false }, die: { at: null }, dead: false, file, options };
  started.push(self);
  self.agent = await agentOver(mediator, () => self, party, party.trace, options);
  return self;
}

/** The party's process ended, if it still runs, and another started over the same file: nothing but the file is carried over. */
export async function restart(running: Running, options: Partial<AgentOptions> = {}): Promise<void> {
  const self = running as Started;
  if (!self.dead) {
    self.agent.close();
    await self.runtime.close();
  }
  const vault = await openVault(openNodeSqlite(self.file, { mode: "readwrite" }), self.party.seedKey);
  self.runtime = vault.runtime;
  self.keys = vault.keys;
  self.dead = false;
  self.agent = await agentOver(self.party.mediator, () => self, vault, await AgentTrace.open(vault.runtime.local), { ...self.options, ...options });
}

/** Closes every party started here and removes its file. */
export async function stopAll(): Promise<void> {
  for (const self of started.splice(0)) {
    if (self.dead) continue;
    self.agent.close();
    await self.runtime.close();
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
}
