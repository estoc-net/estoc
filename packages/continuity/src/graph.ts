/**
 * The continuity graph: channels as vertices, edges that replace exactly
 * one endpoint, and the joins two opposite-side edges leaving one pair
 * imply. Closure is a fixpoint, so the graph is the same whatever order
 * the edges came in. Nothing here knows what a fact is beyond its ID.
 */

import { channelKey, compareChannels, sortedIds } from "./facts.js";
import type { Channel, FactId } from "./types.js";

export type Replaces = "local" | "peer";

export interface Edge {
  readonly from: Channel;
  readonly to: Channel;
  readonly replaces: Replaces;
  readonly support: Set<FactId>;
  /** derived by a join rather than declared by a fact at `from` */
  derived: boolean;
}

export interface Link {
  readonly id: FactId;
  readonly from: Channel;
  readonly to: Channel;
}

/**
 * The channels a forward search reached from its start, each with the
 * edge it was first reached by. Paths are rebuilt from those parent
 * edges only when asked for, so a search costs one entry per channel
 * however long the history is.
 */
export class Reach {
  private readonly reached = new Map<string, { channel: Channel; via: Edge | null }>();

  constructor(start: Channel) {
    this.reached.set(channelKey(start), { channel: start, via: null });
  }

  /** whether `channel` was newly reached through `via` */
  arrive(channel: Channel, via: Edge): boolean {
    const key = channelKey(channel);
    if (this.reached.has(key)) return false;
    this.reached.set(key, { channel, via });
    return true;
  }

  /** every channel reached, the start first, in the order they were reached */
  *channels(): IterableIterator<Channel> {
    for (const { channel } of this.reached.values()) yield channel;
  }

  /** the edges of the path the search took to `channel`, empty for the start, undefined when not reached */
  pathTo(channel: Channel): readonly Edge[] | undefined {
    const end = this.reached.get(channelKey(channel));
    if (end === undefined) return undefined;
    const edges: Edge[] = [];
    for (let entry = end; entry.via !== null; entry = this.reached.get(channelKey(entry.via.from))!) edges.push(entry.via);
    return edges.reverse();
  }
}

export interface IdentityCollision {
  readonly channels: readonly Channel[];
  readonly support: readonly FactId[];
}

export class Graph {
  readonly vertices = new Map<string, Channel>();
  readonly identityCollisions = new Map<string, IdentityCollision>();
  private readonly out = new Map<string, Map<string, Edge>>();
  private readonly into = new Map<string, Map<string, Edge>>();
  private readonly queue: Edge[] = [];

  constructor(private readonly admits: (channel: Channel) => boolean) {}

  vertex(channel: Channel): void {
    const key = channelKey(channel);
    if (!this.vertices.has(key)) this.vertices.set(key, channel);
  }

  add(from: Channel, to: Channel, replaces: Replaces, support: Iterable<FactId>, derived = false): void {
    if (!this.admits(from) || !this.admits(to)) return;
    this.vertex(from);
    this.vertex(to);
    const fromKey = channelKey(from);
    const toKey = channelKey(to);
    let edges = this.out.get(fromKey);
    if (edges === undefined) this.out.set(fromKey, (edges = new Map()));
    const existing = edges.get(toKey);
    if (existing === undefined) {
      const edge: Edge = { from, to, replaces, support: new Set(support), derived };
      edges.set(toKey, edge);
      let inbound = this.into.get(toKey);
      if (inbound === undefined) this.into.set(toKey, (inbound = new Map()));
      inbound.set(fromKey, edge);
      this.queue.push(edge);
      return;
    }
    const before = existing.support.size;
    for (const id of support) existing.support.add(id);
    if (!derived) existing.derived = false;
    if (existing.support.size > before) this.queue.push(existing);
  }

  /** Every join the edges imply, to a fixpoint. */
  close(): void {
    while (this.queue.length > 0) {
      const edge = this.queue.pop()!;
      for (const partner of [...this.from(edge.from)]) {
        if (partner.replaces === edge.replaces) continue;
        const [local, peer] = edge.replaces === "local" ? [edge, partner] : [partner, edge];
        this.join(local, peer);
      }
    }
  }

  private join(local: Edge, peer: Edge): void {
    const localDid = local.to.localDid;
    const peerDid = peer.to.peerDid;
    const support = sortedIds([...local.support, ...peer.support]);
    if (localDid === peerDid) {
      const channels = [local.from, local.to, peer.to];
      this.identityCollisions.set(channels.map(channelKey).join("\u0001"), { channels, support });
      return;
    }
    const joined = { localDid, peerDid };
    this.add(local.to, joined, "peer", support, true);
    this.add(peer.to, joined, "local", support, true);
  }

  from(channel: Channel): Iterable<Edge> {
    return this.out.get(channelKey(channel))?.values() ?? [];
  }

  to(channel: Channel): Iterable<Edge> {
    return this.into.get(channelKey(channel))?.values() ?? [];
  }

  edge(from: Channel, to: Channel): Edge | undefined {
    return this.out.get(channelKey(from))?.get(channelKey(to));
  }

  hasOutgoing(channel: Channel): boolean {
    return (this.out.get(channelKey(channel))?.size ?? 0) > 0;
  }

  *edges(): IterableIterator<Edge> {
    for (const edges of this.out.values()) yield* edges.values();
  }

  /**
   * Every channel forward edges of the given kind reach from `start`,
   * `start` included, each by one shortest path: breadth first over
   * edges in canonical order, so the path chosen is the same whatever
   * order the edges were added. The search stops once it reaches
   * `until`, when one is given.
   */
  reach(start: Channel, replaces: Replaces | "any", until?: Channel): Reach {
    const reach = new Reach(start);
    const untilKey = until === undefined ? undefined : channelKey(until);
    if (untilKey === channelKey(start)) return reach;
    const frontier = [start];
    for (let next = 0; next < frontier.length; next++) {
      for (const edge of [...this.from(frontier[next]!)].sort((a, b) => compareChannels(a.to, b.to))) {
        if (replaces !== "any" && edge.replaces !== replaces) continue;
        if (!reach.arrive(edge.to, edge)) continue;
        if (channelKey(edge.to) === untilKey) return reach;
        frontier.push(edge.to);
      }
    }
    return reach;
  }

  /** The shortest forward path from `from` to `to` as its edges, empty for the same channel, null when none. */
  path(from: Channel, to: Channel): readonly Edge[] | null {
    return this.reach(from, "any", to).pathTo(to) ?? null;
  }

  /**
   * Every strongly connected set of more than one channel, in canonical
   * order: Tarjan's algorithm on an explicit stack, since a replacement
   * history is as deep as the peer made it and the call stack is not.
   */
  cycles(): Channel[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: Channel[] = [];
    const path: { key: string; edges: Iterator<Edge> }[] = [];
    const cycles: Channel[][] = [];
    let next = 0;
    const enter = (channel: Channel) => {
      const key = channelKey(channel);
      index.set(key, next);
      low.set(key, next);
      next++;
      stack.push(channel);
      onStack.add(key);
      path.push({ key, edges: this.from(channel)[Symbol.iterator]() });
    };
    for (const root of this.vertices.values()) {
      if (index.has(channelKey(root))) continue;
      enter(root);
      while (path.length > 0) {
        const frame = path[path.length - 1]!;
        const step = frame.edges.next();
        if (!step.done) {
          const toKey = channelKey(step.value.to);
          if (!index.has(toKey)) enter(step.value.to);
          else if (onStack.has(toKey)) low.set(frame.key, Math.min(low.get(frame.key)!, index.get(toKey)!));
          continue;
        }
        path.pop();
        if (low.get(frame.key) === index.get(frame.key)) {
          const component: Channel[] = [];
          for (;;) {
            const member = stack.pop()!;
            const memberKey = channelKey(member);
            onStack.delete(memberKey);
            component.push(member);
            if (memberKey === frame.key) break;
          }
          if (component.length > 1) cycles.push(component.sort(compareChannels));
        }
        const parent = path[path.length - 1];
        if (parent !== undefined) low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
      }
    }
    return cycles.sort((a, b) => compareChannels(a[0]!, b[0]!));
  }
}

/**
 * The least graph over the given links and the candidates `confirms`
 * admits. A candidate is judged against the graph built without it and
 * every candidate still waiting, so nothing it derives can confirm it;
 * the graph is rebuilt until no candidate is admitted any more. The
 * confirming facts of each admitted candidate are returned with it.
 * Candidates are told apart as objects, since two variants of one fact
 * ID are two candidates.
 */
export function closure<L extends Link>(
  peerLinks: readonly Link[],
  candidates: readonly L[],
  admits: (channel: Channel) => boolean,
  confirms: (graph: Graph, candidate: L) => readonly FactId[] | null
): { graph: Graph; admitted: Map<L, readonly FactId[]>; waiting: Set<L> } {
  const admitted = new Map<L, readonly FactId[]>();
  const waiting = new Set(candidates);
  const build = () => {
    const graph = new Graph(admits);
    for (const link of peerLinks) graph.add(link.from, link.to, "peer", [link.id]);
    for (const [link, support] of admitted) graph.add(link.from, link.to, "local", [link.id, ...support]);
    graph.close();
    return graph;
  };
  let graph = build();
  for (;;) {
    let progressed = false;
    for (const link of waiting) {
      if (admitted.has(link)) continue;
      const support = confirms(graph, link);
      if (support === null) continue;
      admitted.set(link, support);
      progressed = true;
    }
    if (!progressed) break;
    graph = build();
  }
  for (const link of admitted.keys()) waiting.delete(link);
  return { graph, admitted, waiting };
}

/** Union-find over channel keys: the contexts one kind of edge connects. */
export class Contexts {
  private readonly parent = new Map<string, string>();

  constructor(graph: Graph, replaces: Replaces) {
    for (const edge of graph.edges()) if (edge.replaces === replaces) this.union(channelKey(edge.from), channelKey(edge.to));
  }

  private find(key: string): string {
    let root = key;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) root = this.parent.get(root)!;
    for (let node = key; node !== root; ) {
      const next = this.parent.get(node)!;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  private union(a: string, b: string): void {
    if (!this.parent.has(a)) this.parent.set(a, a);
    if (!this.parent.has(b)) this.parent.set(b, b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // the smaller key roots the context, so the root is the same whatever the union order
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }

  /** The root key of the context; the key itself for a channel no edge of this kind touches. */
  root(key: string): string {
    return this.parent.has(key) ? this.find(key) : key;
  }
}
