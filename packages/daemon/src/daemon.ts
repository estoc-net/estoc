import { v7 as uuidv7 } from "uuid";
import { DatabaseBusy, SqliteVault, exportVault, importVault, openPortable, restoreVault, type SqliteDriver } from "@estoc/event-store";
import { createSeedKeystore, unlockSeedKeystore, type SeedKey } from "@estoc/keystore";
import {
  Keys,
  PING_TYPE,
  canonicalDidOf,
  objectReader,
  scanVault,
  vaultDraft,
  vaultHeldRoots,
  vaultRetention,
  type Channel,
  type ContactId,
  type Did,
  type VaultDraft,
  type VaultFold,
} from "@estoc/vault";
import {
  Agent,
  AgentTrace,
  BUILT_IN_HANDLERS,
  MAX_CONTENT_BYTES,
  createDid,
  createMediation,
  createVault,
  decide,
  effectTypesOf,
  ensureRoute,
  inspectRuntime,
  isTraceLevel,
  openVault,
  recorder,
  sameDid,
  selectMediation,
  type Called,
  type ChannelRecord,
  type EffectOutcome,
  type InspectedRuntime,
} from "@estoc/agent-core";

import type { ContactSummary, Daemon, Lines, Outcome, Phase, Snapshot } from "./api.js";
import { VAULT_FILE, type DaemonHost, type DaemonStorage } from "./host.js";

/** How the daemon raises an event: a name and its arguments, to whoever listens. */
export type Emit = (name: string, ...args: unknown[]) => void;

/** The daemon as its host holds it: the UI's interface, and a replay for one listener. */
export interface DaemonCore extends Daemon {
  /** whether `boot()` has run: a later `boot()` is a replay */
  readonly booted: boolean;
  /** Say where things stand again, to `to` alone — for a listener that was not there the first time. */
  replayTo(to: Emit): Promise<void>;
  /**
   * The agent closed and the files let go of, for the host that is
   * shutting down; the seed stays cached where the host keeps it. A wait
   * for files held elsewhere ends, the operation under way is waited
   * for, a request the agent has with a mediator is waited for as long
   * as the agent gives it and none follows it, and nothing is opened,
   * sent or said afterwards; every call answers with the one closing.
   */
  close(): Promise<void>;
}

/**
 * This runtime's own record that whoever runs it knows what a restore
 * cannot bring back: set when the vault is created here, and when the
 * person is told after a restore. It is absent from a runtime a
 * restore has just made — local state is never part of a snapshot —
 * so a restore interrupted anywhere leaves sending closed rather than
 * open.
 */
export const RESTORE_EXPLAINED = "daemon.restoreExplained";

const RESTORE_SOURCE = "restore-source.sqlite";
const MERGE_SOURCE = "merge-source.sqlite";
const EXPORT_FILE = "export.sqlite";
const BUSY_RETRY_MS = 2000;
const CLOSED = "the daemon is closed";
const DETACHED = "the agent is closed";

const SCAN = { effectTypes: effectTypesOf(BUILT_IN_HANDLERS) };

/**
 * One agent as the daemon holds it. Closing an agent does not end a
 * flow of its own already under way, and such a flow goes on from what
 * it read before: a reconciliation would take away the addresses
 * whoever has the vault next has registered since. So once `ended`
 * the agent starts no request, and `work` is waited for before the
 * vault is closed or handed to another agent: every call made over
 * the agent, and every request the agent has out, whoever began it —
 * a call, a retry on its timer, a delivery pushed down its socket. A
 * request already out is left to be answered: giving it up here would
 * not undo it there, and whoever came next would register addresses
 * under a removal still to land. One that outlasts the deadline its
 * caller set is past waiting for; it may still take effect at the
 * other end later, and a reconciliation after it sees and mends only
 * what stands there at the time.
 */
interface Attached {
  agent: Promise<Agent>;
  ended: boolean;
  work: Set<Promise<void>>;
}

interface Open {
  runtime: SqliteVault;
  keys: Keys;
  trace: AgentTrace;
  attached: Attached;
}

/**
 * `ask`'s response, kept in `work` until it is over: its body read to
 * the end or let go of by its reader, the request failed, or `deadline`
 * passed. The body goes through as it comes, so a reader's bound on it
 * still bounds what is read.
 */
async function answered(work: Set<Promise<void>>, deadline: AbortSignal | null, ask: () => Promise<Response>): Promise<Response> {
  let over = (): void => undefined;
  const pending = new Promise<void>((resolve) => (over = resolve));
  work.add(pending);
  void pending.then(() => work.delete(pending));
  deadline?.addEventListener("abort", over, { once: true });
  let response: Response;
  try {
    response = await ask();
  } catch (err) {
    over();
    throw err;
  }
  if (response.body === null) {
    over();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
      over();
    },
    async cancel(reason) {
      over();
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const failure = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const outcomeOf = (called: Called): Outcome => ({ outcome: called.outcome, because: "because" in called ? called.because : "reason" in called ? called.reason : null });

function effectOutcomeOf(effect: EffectOutcome): Outcome {
  if (effect.outcome === "none" || effect.outcome === "refused") return { outcome: effect.outcome, because: effect.because };
  return effect.dispatched === null ? { outcome: effect.outcome, because: null } : outcomeOf(effect.dispatched);
}

/**
 * The daemon itself, wherever it runs: the vault among the host's
 * files, owned for as long as the daemon looks at it or runs it, the
 * seed unlocked from the vault's own wrapper and cached where the host
 * keeps such things, and the agent over it. A UI renders what the
 * events say and asks for things through the `Daemon` methods.
 *
 * `boot` is the entry and may be called again — by a second UI joining
 * a daemon already up, or one reconnecting — in which case it replays
 * where things stand rather than opening anything twice.
 */
export function createDaemon(host: DaemonHost, emit: Emit): DaemonCore {
  let storage: DaemonStorage | null = null;
  /** the locked phase's hold on the vault: the file owned, nothing written, the wrapped seed for `unlock` */
  let inspected: InspectedRuntime | null = null;
  let open: Open | null = null;
  let booted = false;
  let current: Phase = "booting";
  let detail: string | null = null;

  let closed: Promise<void> | null = null;
  const closing = () => closed !== null;
  const waits = new Set<() => void>();

  const phase = (p: Phase, why: string | null = null) => {
    if (closing()) return;
    current = p;
    detail = why;
    emit("phase", p, why);
  };
  const log = (line: string) => emit("log", line);

  let turn: Promise<void> = Promise.resolve();
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const done = turn.then(work);
    turn = done.then(
      () => undefined,
      () => undefined
    );
    return done;
  }

  /**
   * Whatever makes, opens, closes or removes one of the daemon's files
   * runs one at a time, in the order asked: what an operation found
   * when it checked still holds when it acts, and no file is closed or
   * removed under another still using it. A daemon waiting for files
   * held elsewhere refuses it rather than leave it waiting behind that.
   */
  async function exclusively<T>(work: () => Promise<T>): Promise<T> {
    if (closing()) throw new Error(CLOSED);
    if (current === "elsewhere") throw new Error("the vault is held elsewhere");
    return inTurn(() => {
      if (closing()) throw new Error(CLOSED);
      return work();
    });
  }

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const over = () => {
        clearTimeout(timer);
        waits.delete(over);
        resolve();
      };
      const timer = setTimeout(over, ms);
      waits.add(over);
    });
  }

  /** `take`, tried again for as long as somebody else holds what it opens; a daemon that closes meanwhile stops asking, and gives back with `release` what it was handed too late. */
  async function owned<T>(take: () => Promise<T>, release: (taken: T) => unknown): Promise<T> {
    for (;;) {
      if (closing()) throw new Error(CLOSED);
      try {
        const taken = await take();
        if (!closing()) return taken;
        await release(taken);
      } catch (err) {
        if (!(err instanceof DatabaseBusy)) throw err;
        if (current !== "elsewhere") phase("elsewhere");
        await pause(BUSY_RETRY_MS);
      }
    }
  }

  function files(): DaemonStorage {
    if (storage === null) throw new Error("storage is not available");
    return storage;
  }

  /** A vault is made only where the daemon found none: not beside one it holds, and not over what it could not read. */
  async function refuseOccupied(): Promise<DaemonStorage> {
    const store = files();
    if (current !== "onboarding" || (await store.has(VAULT_FILE))) throw new Error("a vault already exists here");
    return store;
  }

  function vault(): Open {
    if (open === null) throw new Error("no open vault");
    return open;
  }

  const takeVault = (mode: "create" | "readwrite"): Promise<SqliteDriver> =>
    owned(
      () => files().open(VAULT_FILE, mode, "runtime"),
      async (driver) => {
        driver.close();
        if (mode === "create") await files().remove(VAULT_FILE);
      }
    );

  async function snapshot({ runtime, keys }: Open): Promise<Snapshot> {
    const fold = await scanVault(runtime.vault, keys, SCAN);
    const records = recorder(fold, objectReader(runtime.vault.objects, MAX_CONTENT_BYTES));
    const channels = new Map<string, ChannelRecord>();
    const keyOf = (channel: Channel) => JSON.stringify([channel.localDid, channel.peerDid]);
    const contacts: ContactSummary[] = [];
    for (const contactId of records.contactIds()) {
      const { channels: shown, ...contact } = await records.contact(contactId);
      for (const { selected: _selected, ...record } of shown) channels.set(keyOf(record.channel), record);
      contacts.push({ ...contact, channels: shown.map(({ channel, selected }) => ({ channel, selected })) });
    }
    for (const channel of records.channels()) if (!channels.has(keyOf(channel))) channels.set(keyOf(channel), await records.channel(channel));
    return {
      anchor: runtime.metadata.anchor as Did,
      label: fold.label ?? "",
      restoreUnexplained: !(await explained(runtime)),
      mediations: [...fold.mediations.mediations.values()].map((mediation) => ({
        mediationId: mediation.mediationId,
        mediatorDid: mediation.mediatorDid,
        selected: fold.mediations.selected === mediation.mediationId,
        usable: fold.mediations.usable(mediation.mediationId),
        retired: mediation.retired,
        faults: [...mediation.faults],
      })),
      dids: [...fold.routes.dids.values()].map((entity) => ({
        didId: entity.didId,
        did: entity.created?.did ?? null,
        live: entity.live,
        retired: entity.retired,
        disclosed: entity.disclosures.length > 0,
        faults: [...entity.faults],
      })),
      contacts,
      channels: [...channels.values()],
      unplaced: await records.unplaced(),
      invitations: records.invitations(),
      pending: records.pending(),
    };
  }

  const explained = async (runtime: SqliteVault): Promise<boolean> => (await runtime.local.options.get(RESTORE_EXPLAINED)) === true;

  /** A send of the user's and every manual dispatch wait for the restore to be explained; nothing the vault does on its own does. */
  async function refuseUnexplained({ runtime }: Open): Promise<void> {
    if (!(await explained(runtime))) throw new Error("this vault was restored from a snapshot: sending opens once what a restore cannot bring back has been explained");
  }

  let telling: Promise<void> | null = null;
  let stale = false;
  /** The snapshot to every listener; a change that lands while one is being read is told by one more read after it. */
  function tell(): Promise<void> {
    if (telling !== null) {
      stale = true;
      return telling;
    }
    telling = (async () => {
      do {
        stale = false;
        if (open !== null) emit("changed", await snapshot(open));
      } while (stale);
    })()
      .catch((err) => log(`the snapshot could not be read: ${failure(err)}`))
      .finally(() => {
        telling = null;
      });
    return telling;
  }

  const linesOf = (agent: Agent): Lines => ({ connections: agent.connections(), waiting: agent.waitingDeliveries(), discarded: agent.discardedDeliveries() });

  function attach(runtime: SqliteVault, keys: Keys, trace: AgentTrace): Attached {
    const attached = { ended: false, work: new Set<Promise<void>>() };
    const reach = host.agentOptions?.fetch ?? globalThis.fetch;
    const whileAttached =
      <A extends unknown[]>(say: (...args: A) => void) =>
      (...args: A) => {
        if (!attached.ended) say(...args);
      };
    const opening = async (): Promise<Agent> => {
      const agent = await Agent.open(
        { runtime, keys },
        {
          ...host.agentOptions,
          fetch: async (input, init) => {
            if (attached.ended) throw new Error(DETACHED);
            return answered(attached.work, init?.signal ?? null, () => reach(input, init));
          },
          didcomm: await host.didcomm(),
          trace,
          log: whileAttached(log),
          onInbound: whileAttached(() => {
            void tell();
            emit("lines", linesOf(agent));
          }),
        }
      );
      return agent;
    };
    const agent = opening();
    agent.catch(() => undefined);
    return Object.assign(attached, { agent });
  }

  /** `work` over the agent, refused once the agent is detached and waited for by whoever detaches it. */
  function during<T>(attached: Attached, work: (agent: Agent) => Promise<T>): Promise<T> {
    const done = attached.agent.then((agent) => {
      if (attached.ended) throw new Error(DETACHED);
      return work(agent);
    });
    const settled = done.then(
      () => undefined,
      () => undefined
    );
    attached.work.add(settled);
    void settled.then(() => attached.work.delete(settled));
    return done;
  }

  async function detach(attached: Attached): Promise<void> {
    attached.ended = true;
    while (attached.work.size > 0) await Promise.all(attached.work);
    await attached.agent.then(
      (agent) => agent.close(),
      () => undefined
    );
  }

  /** The agent's lines connected, in the background: a mediator out of reach keeps no screen waiting. */
  function connect(running: Open): void {
    const { attached } = running;
    during(attached, async (agent) => {
      await agent.connect();
      if (open === running && running.attached === attached) emit("lines", linesOf(agent));
    }).catch((err) => {
      if (!attached.ended) log(`the agent did not come up: ${failure(err)}`);
    });
  }

  async function start(runtime: SqliteVault, keys: Keys): Promise<void> {
    let running: Open;
    try {
      if (closing()) throw new Error(CLOSED);
      const trace = await AgentTrace.open(runtime.local);
      running = { runtime, keys, trace, attached: attach(runtime, keys, trace) };
    } catch (err) {
      await runtime.close();
      throw err;
    }
    open = running;
    current = "open";
    detail = null;
    emit("opened", await snapshot(running));
    connect(running);
  }

  async function stop(): Promise<void> {
    const running = open;
    open = null;
    if (running === null) return;
    await detach(running.attached);
    await running.runtime.close();
  }

  async function run(seedKey: SeedKey): Promise<void> {
    const opened = await openVault(await takeVault("readwrite"), seedKey, SCAN);
    await start(opened.runtime, opened.keys);
  }

  /** The vault owned and looked at without its seed, for `unlock`; one that does not open is said to be unreadable, its bytes left alone. */
  async function look(): Promise<void> {
    try {
      inspected = await inspectRuntime(await takeVault("readwrite"), SCAN);
      phase("locked");
    } catch (err) {
      phase("unreadable", failure(err));
    }
  }

  async function letGo(): Promise<void> {
    const held = inspected;
    inspected = null;
    await held?.runtime.close();
  }

  /** `work` over the running agent, and the vault told again afterwards whether or not it threw: a call that failed may have committed. */
  async function act<T>(work: (agent: Agent, running: Open) => Promise<T>): Promise<T> {
    const running = vault();
    const { attached } = running;
    return during(attached, async (agent) => {
      try {
        return await work(agent, running);
      } finally {
        if (open === running) {
          await tell();
          if (running.attached === attached) emit("lines", linesOf(agent));
        }
      }
    });
  }

  const commit = ({ runtime, keys }: Open, choose: (fold: VaultFold) => VaultDraft[]) => decide(runtime, keys, choose);

  function contactOf(fold: VaultFold, contactId: ContactId): void {
    const contact = fold.contacts.contacts.get(contactId);
    if (contact === undefined || contact.origin === null || contact.deleted) throw new Error(`no contact ${contactId}`);
  }

  async function preferredRoute({ runtime, keys }: Open) {
    const preferred = (await scanVault(runtime.vault, keys, SCAN)).mediations.preferred;
    if (preferred === null) throw new Error("no mediator is set");
    return ensureRoute(runtime, keys, preferred);
  }

  /**
   * A portable snapshot's bytes as a file of the host's for the length
   * of `use`, opened read-only. Whatever stands under `name` beforehand
   * is what a run cut short left behind: the files are this daemon's
   * alone, and the operations that put one there take turns.
   */
  async function withSnapshot<T>(name: string, bytes: Uint8Array, use: (driver: SqliteDriver) => Promise<T>): Promise<T> {
    const store = files();
    await store.remove(name);
    await store.importFile(name, bytes);
    try {
      return await use(await store.open(name, "readonly", "portable"));
    } finally {
      await store.remove(name);
    }
  }

  host.onOnline?.(() => {
    const running = open;
    if (running === null) return;
    connect(running);
  });

  async function replayTo(to: Emit): Promise<void> {
    const running = open;
    if (running === null) {
      to("phase", current, detail);
      return;
    }
    to("opened", await snapshot(running));
    void running.attached.agent.then(
      (agent) => to("lines", linesOf(agent)),
      () => undefined
    );
  }

  return {
    get booted() {
      return booted;
    },
    replayTo,
    close() {
      closed ??= inTurn(async () => {
        try {
          await stop();
          await letGo();
        } finally {
          const held = storage;
          storage = null;
          await held?.close();
        }
      });
      for (const over of [...waits]) over();
      return closed;
    },

    async boot() {
      if (booted) {
        await replayTo(emit);
        return;
      }
      booted = true;
      await inTurn(async () => {
        const foreign = (await host.unreadable?.()) ?? null;
        if (foreign !== null) {
          phase("unreadable", foreign);
          return;
        }
        try {
          storage = await owned(
            () => host.storage(),
            (taken) => taken.close()
          );
        } catch (err) {
          phase("unreadable", failure(err));
          return;
        }
        if (!(await storage.has(VAULT_FILE))) {
          phase("onboarding");
          return;
        }
        const seedKey = await host.cachedSeedKey();
        if (seedKey === null) {
          await look();
          return;
        }
        try {
          await run(seedKey);
        } catch (err) {
          phase("unreadable", failure(err));
        }
      });
    },

    createIdentity: (name, passphrase) =>
      exclusively(async () => {
        const store = await refuseOccupied();
        const { doc, seedKey } = await createSeedKeystore(passphrase);
        const driver = await takeVault("create");
        let created: Awaited<ReturnType<typeof createVault>>;
        try {
          created = await createVault(driver, { seedKey, wrapped: { version: 3, seedJwe: doc.seedJwe }, label: name, ...SCAN });
          await created.runtime.local.options.set(RESTORE_EXPLAINED, true);
        } catch (err) {
          // The file is this call's own to remove only past the open that made it, and only once its connection is closed.
          driver.close();
          await store.remove(VAULT_FILE);
          throw err;
        }
        await host.cacheSeedKey(seedKey);
        await start(created.runtime, created.keys);
      }),

    restoreIdentity: (bytes, passphrase) =>
      exclusively(async () => {
        const store = await refuseOccupied();
        const unlocked: { seedKey: SeedKey | null } = { seedKey: null };
        let made = false;
        let runtime: SqliteVault;
        let keys: Keys;
        try {
          runtime = await withSnapshot(RESTORE_SOURCE, bytes, async (driver) => {
            const source = openPortable(driver);
            try {
              const restored = await restoreVault(
                source,
                async (mode) => {
                  const destination = await store.open(VAULT_FILE, mode, "runtime");
                  made = true;
                  return destination;
                },
                {
                  heldRoots: vaultHeldRoots(null, SCAN),
                  anchor: async (wrapped) => {
                    try {
                      unlocked.seedKey = await unlockSeedKeystore({ version: 3, seedJwe: wrapped.seedJwe }, passphrase);
                    } catch {
                      throw new Error("that passphrase does not open this backup");
                    }
                    return Keys.anchorOf(unlocked.seedKey);
                  },
                }
              );
              return new SqliteVault(restored.runtime);
            } finally {
              source.close();
            }
          });
        } catch (err) {
          // A destination the restore made and failed on is closed and unready: it opens as nothing, and the next try starts from no file.
          if (made) await store.remove(VAULT_FILE);
          throw err;
        }
        const { seedKey } = unlocked;
        try {
          if (seedKey === null) throw new Error("the restore did not ask for the passphrase");
          keys = await Keys.open(seedKey, runtime.metadata.anchor);
        } catch (err) {
          await runtime.close();
          await store.remove(VAULT_FILE);
          throw err;
        }
        await host.cacheSeedKey(seedKey);
        await start(runtime, keys);
      }),

    async explainedRestore() {
      const running = vault();
      await running.runtime.local.options.set(RESTORE_EXPLAINED, true);
      await tell();
    },

    unlock: (passphrase) =>
      exclusively(async () => {
        if (inspected === null) throw new Error("nothing to unlock");
        let seedKey: SeedKey;
        try {
          seedKey = await unlockSeedKeystore({ version: 3, seedJwe: inspected.wrapped.seedJwe }, passphrase);
        } catch {
          throw new Error("wrong passphrase");
        }
        await letGo();
        try {
          await run(seedKey);
        } catch (err) {
          await look();
          throw err;
        }
        await host.cacheSeedKey(seedKey);
      }),

    lock: () =>
      exclusively(async () => {
        await host.forgetSeedKey();
        // Locked already, the vault stays in the hold it is in: a second look would wait on this daemon's own.
        if (inspected !== null) return;
        await stop();
        if (await files().has(VAULT_FILE)) await look();
        else phase("onboarding");
      }),

    forgetIdentity: () =>
      exclusively(async () => {
        const store = files();
        await stop();
        await letGo();
        await host.forgetSeedKey();
        await store.remove(VAULT_FILE);
        phase("onboarding");
      }),

    exportBackup: () =>
      exclusively(async () => {
        const { runtime, keys } = vault();
        const store = files();
        await store.remove(EXPORT_FILE);
        try {
          await exportVault(runtime, (mode) => store.open(EXPORT_FILE, mode, "portable"), { heldRoots: vaultHeldRoots(keys, SCAN) });
          const label = (await scanVault(runtime.vault, keys, SCAN)).label ?? "";
          const stem = label.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "vault";
          return { name: `${stem}-${new Date().toISOString().slice(0, 10)}.estoc.sqlite`, bytes: await store.exportFile(EXPORT_FILE) };
        } finally {
          await store.remove(EXPORT_FILE);
        }
      }),

    mergeBackup: (bytes) =>
      exclusively(async () => {
        const running = vault();
        const imported = await withSnapshot(MERGE_SOURCE, bytes, async (driver) => {
          const source = openPortable(driver);
          try {
            return await importVault(running.runtime, source, { retainedRoots: vaultRetention(running.keys, SCAN) });
          } finally {
            source.close();
          }
        });
        // The agent read its keys and its lines before the merge: another over the merged vault takes its place.
        await detach(running.attached);
        running.attached = attach(running.runtime, running.keys, running.trace);
        await tell();
        connect(running);
        const { added, duplicates, conflicts, objects, repaired } = imported;
        return { added, duplicates, conflicts: conflicts.length, objects, repaired };
      }),

    setMediator: (mediatorDid) =>
      act(async (agent, { runtime, keys }) => {
        const fold = await scanVault(runtime.vault, keys, SCAN);
        const existing = [...fold.mediations.mediations.values()].find((mediation) => mediation.mediatorDid !== null && mediation.retired === null && mediation.faults.length === 0 && sameDid(mediation.mediatorDid, mediatorDid));
        const mediationId = existing?.mediationId ?? (await createMediation(runtime, keys, mediatorDid as Did)).data.mediationId;
        await agent.establish(mediationId);
        await selectMediation(runtime, keys, mediationId);
        await ensureRoute(runtime, keys, mediationId);
        return mediationId;
      }),

    createInvitation: (uses, goal) =>
      act(async (agent, running) => {
        const { created } = await createDid(running.runtime, running.keys, await preferredRoute(running));
        const { invitation } = await agent.disclose(created.data.didId, { as: "oob", uses, goal: goal ?? null });
        if (invitation === null) throw new Error("the disclosure made no invitation");
        return { didId: created.data.didId, invitation };
      }),

    acceptInvitation: (invitation, petname) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        const peerDid = canonicalDidOf(invitation.from as Did);
        const { minted } = await createDid(running.runtime, running.keys, await preferredRoute(running));
        const channel: Channel = { localDid: minted.did, peerDid };
        const contactId = uuidv7() as ContactId;
        await commit(running, () => [vaultDraft("contact.created", { contactId, because: "user" }), vaultDraft("contact.petname", { contactId, name: petname }), vaultDraft("contact.channelsSet", { contactId, channels: [channel] })]);
        const sent = await agent.send({ channel, recipientDid: invitation.from }, { type: PING_TYPE, body: { response_requested: true }, pthid: invitation.id, pleaseAck: [""] });
        return { contactId, messageId: sent.messageId, channel: sent.channel, ...outcomeOf(sent.dispatched) };
      }),

    createContact: (petname, channels) =>
      act(async (_agent, running) => {
        const contactId = uuidv7() as ContactId;
        await commit(running, () => [vaultDraft("contact.created", { contactId, because: "user" }), vaultDraft("contact.petname", { contactId, name: petname }), vaultDraft("contact.channelsSet", { contactId, channels })]);
        return contactId;
      }),

    renameContact: (contactId, petname) =>
      act(async (_agent, running) => {
        await commit(running, (fold) => {
          contactOf(fold, contactId);
          return [vaultDraft("contact.petname", { contactId, name: petname })];
        });
      }),

    setContactChannels: (contactId, channels) =>
      act(async (_agent, running) => {
        await commit(running, (fold) => {
          contactOf(fold, contactId);
          return [vaultDraft("contact.channelsSet", { contactId, channels })];
        });
      }),

    deleteContact: (contactId, options) =>
      act(async (agent) => {
        await agent.manual.deleteContact(contactId, options);
      }),

    blockChannels: (channels, includeSuccessors) =>
      act(async (agent) => {
        await agent.manual.blockChannels(channels, includeSuccessors);
      }),

    eraseMessage: (messageId) =>
      act(async (agent) => {
        await agent.manual.eraseMessage(messageId);
      }),

    send: (target, content) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        const sent = await agent.send(target, content);
        return { messageId: sent.messageId, channel: sent.channel, ...outcomeOf(sent.dispatched) };
      }),

    retry: (messageId) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        return outcomeOf(await agent.manual.retry(messageId));
      }),

    cancel: (messageId) =>
      act(async (agent) => {
        const cancelled = await agent.manual.cancel(messageId);
        return { outcome: cancelled.outcome, because: cancelled.outcome === "none" ? cancelled.because : null };
      }),

    completeResponse: (executionId, effectType) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        return effectOutcomeOf(await agent.manual.completeResponse(executionId, effectType));
      }),

    completeNotification: (rotationEventId) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        return effectOutcomeOf(await agent.manual.completeNotification(rotationEventId));
      }),

    rotate: (localDidId, peerDid) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        const rotated = await agent.manual.rotate({ localDidId, peerDid });
        return { successor: rotated.successor, existed: rotated.existed, ...effectOutcomeOf(rotated.notification) };
      }),

    pending: async () => during(vault().attached, (agent) => agent.pending()),

    async refresh() {
      vault();
      await tell();
    },

    async reconnect() {
      const running = vault();
      const { attached } = running;
      await during(attached, async (agent) => {
        await agent.connect();
        if (open === running && running.attached === attached) emit("lines", linesOf(agent));
      });
    },

    traceLevel: async () => vault().trace.level,

    async setTraceLevel(level) {
      if (!isTraceLevel(level)) throw new Error(`no such trace level: ${String(level)}`);
      await vault().trace.setLevel(level);
      return level;
    },
  };
}
