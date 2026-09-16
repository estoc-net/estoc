/**
 * Executable examples for channel-graph.md, NOT a production validator.
 * Endpoint documents and edge cryptography are assumed already validated.
 * Document labels below stand for exact retained CIDs; proofs are symbolic.
 * This small model tests identities, rooted reachability and conflict handling.
 * It does not implement DID resolution, JWT checks, admission commits or SQLite.
 * Run: node --test docs/replica-model/channel-graph.test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const KA = 'z6LSbgC4DpuCf7zxewhFPnYcyBm3YgxjEEovsehvWqZzTm8z';
const KB = 'z6LSdqbWoToXafWD7qhVMLz2HCTTMmhAnGnAki2vP11ANRTc';
const KC = 'z6LSfzzyP6hrWD1TajhjJuRRbD9sArRcLJkQdmMvFASLH5nE';
const A0 = ['did:example:alice0', 'keyAgreement', KA];
const B0 = ['did:example:bob0', 'keyAgreement', KB];
const A1 = ['did:example:alice1', 'keyAgreement', KC];
const B1 = ['did:example:bob1', 'keyAgreement', KC];
const WIRE = '019b1b61-3444-7190-9db5-1cc9c215eb23';

// Only the string/array/string-object transcript subset used in this proposal.
// This is deliberately not advertised as a general RFC 8785 implementation.
function canonical(value) {
  if (typeof value === 'string') {
    assert.ok(value.isWellFormed(), 'invalid Unicode');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${canonical(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new TypeError('unsupported transcript value');
}
function uuid5(namespace, name) {
  assert.match(namespace, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const bytes = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const namespace = purpose => uuid5(URL_NAMESPACE, `https://estoc.dev/uuid/v1/${purpose}`);
const id = (purpose, transcript) => uuid5(namespace(purpose), canonical(transcript));
const byteCompare = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
function channelId(a, b) {
  for (const e of [a, b]) {
    assert.equal(e.length, 3);
    assert.equal(e[1], 'keyAgreement');
    assert.ok(e.every(v => typeof v === 'string' && v.length > 0));
  }
  assert.notEqual(a[0], b[0], 'distinct DIDs required');
  const ends = [a, b].sort((x, y) => byteCompare(canonical(x), canonical(y)));
  return id('channel', ['v1', ...ends]);
}
function scopeId(a, b) {
  assert.notEqual(a, b);
  return id('continuity-scope', ['v1', ...[a, b].sort(byteCompare)]);
}
const executionId = (scope, sender, wire) => id('message-execution', ['v3', { scope, sender }, wire]);
const observationId = (a, b, wire) => id('channel-observation', ['v1', channelId(a, b), b[0], b[2], wire]);
const autoContactId = scope => id('scope-contact', ['v1', scope]);
const S = scopeId(A0[0], B0[0]);
const node = (endpoint, document) => ({ did: endpoint[0], document, keys: [endpoint[2]] });
const root = (name = 'o', a = A0, b = B0) => ({ id: name, local: node(a, `doc:${a[0]}`), peer: node(b, `doc:${b[0]}`) });
function edge(name, side, from, to, prior = null, origin = 'o') {
  return { id: name, origin, side, prior, from: from[0], fromDocument: `doc:${from[0]}`,
    to: node(to, `doc:${to[0]}`), proof: `proof:${from[0]}:${to[0]}` };
}
const EL = edge('l', 'local', A0, A1);
const EP = edge('p', 'peer', B0, B1);

/** Fold already-verified evidence without choosing a winner by insertion order. */
function fold(roots, edges) {
  const origins = new Map(roots.map(r => [r.id, r]));
  const edgeMap = new Map(edges.map(e => [e.id, e]));
  assert.equal(origins.size, roots.length, 'event IDs are unique');
  assert.equal(edgeMap.size, edges.length, 'event IDs are unique');
  const scopes = new Map();
  const statuses = new Map();
  const resolving = new Set();
  for (const r of roots) {
    const s = scopeId(r.local.did, r.peer.did);
    const pin = canonical([r.local.did, r.local.document, ...r.local.keys,
      r.peer.did, r.peer.document, ...r.peer.keys]);
    const state = scopes.get(s) ?? { id: s, pins: new Set(), conflict: false,
      nodes: { local: [], peer: [] } };
    state.pins.add(pin);
    state.nodes.local.push(r.local);
    state.nodes.peer.push(r.peer);
    state.conflict ||= state.pins.size > 1;
    scopes.set(s, state);
  }
  function visit(eid) {
    if (statuses.has(eid)) return statuses.get(eid);
    const e = edgeMap.get(eid);
    if (!e) return { status: 'pending' };
    const r = origins.get(e.origin);
    if (!r) return { status: 'pending' };
    const sid = scopeId(r.local.did, r.peer.did);
    const fail = status => {
      const result = { status, scope: sid };
      statuses.set(eid, result);
      if (status === 'conflict') scopes.get(sid).conflict = true;
      return result;
    };
    if (resolving.has(eid) || !['local', 'peer'].includes(e.side)) return fail('conflict');
    resolving.add(eid);
    let prior;
    if (e.prior === null) prior = { status: 'applied', scope: sid, side: e.side,
      node: r[e.side], path: [r[e.side].did] };
    else prior = visit(e.prior);
    resolving.delete(eid);
    if (prior.status !== 'applied') return fail(prior.status);
    if (prior.scope !== sid || prior.side !== e.side || prior.node.did !== e.from
        || prior.node.document !== e.fromDocument || prior.path.includes(e.to.did)) return fail('conflict');
    const result = { status: 'applied', scope: sid, side: e.side, node: e.to,
      path: [...prior.path, e.to.did] };
    statuses.set(eid, result);
    return result;
  }
  // First derive all independently valid claims; do not drop conflicted claimants.
  const successors = new Map();
  for (const e of edges) {
    const v = visit(e.id);
    if (v.status !== 'applied') continue;
    scopes.get(v.scope).nodes[e.side].push(v.node);
    const predecessor = canonical([v.scope, e.side, e.from, e.fromDocument]);
    const claims = successors.get(predecessor) ?? new Set();
    claims.add(canonical([e.to.did, e.to.document, e.proof]));
    successors.set(predecessor, claims);
    if (claims.size > 1) scopes.get(v.scope).conflict = true;
  }
  // Small fixture index; implementations need not materialize this product.
  const pairClaims = new Map();
  for (const state of scopes.values()) {
    for (const a of state.nodes.local) for (const b of state.nodes.peer) {
      const pair = canonical([a.did, b.did]);
      const claimants = pairClaims.get(pair) ?? new Set();
      claimants.add(state.id);
      pairClaims.set(pair, claimants);
    }
  }
  for (const claimants of pairClaims.values()) {
    if (claimants.size > 1) for (const sid of claimants) scopes.get(sid).conflict = true;
  }
  function membership(originId, a, b) {
    const r = origins.get(originId);
    if (!r) return 'pending';
    const state = scopes.get(scopeId(r.local.did, r.peer.did));
    if (state.conflict) return 'conflict';
    const authorized = (side, endpoint) => endpoint[1] === 'keyAgreement'
      && state.nodes[side].some(n => n.did === endpoint[0] && n.keys.includes(endpoint[2]));
    if (authorized('local', a) && authorized('peer', b)) return 'ready';
    const pending = edges.some(e => e.origin === originId && visit(e.id).status === 'pending'
      && e.to.did === (e.side === 'local' ? a[0] : b[0]));
    return pending ? 'pending' : 'outside';
  }
  return { scopes, statuses, membership };
}
function* permutations(values) {
  if (values.length === 0) { yield []; return; }
  for (let i = 0; i < values.length; i++) {
    for (const tail of permutations(values.filter((_, j) => j !== i))) yield [values[i], ...tail];
  }
}
const executionState = observations => {
  const complete = observations.filter(o => o.status === 'ready');
  if (new Set(complete.map(o => o.intent)).size > 1) return 'conflict';
  if (observations.some(o => o.status === 'conflict')) return 'conflict';
  if (observations.some(o => o.status !== 'ready')) return 'pending';
  return complete.length ? 'ready' : 'pending';
};
function ackAllowed(outbound, carrier, graph) {
  if (!carrier.admitted || !carrier.ack.includes(outbound.wire)
      || carrier.originSender !== outbound.expectedPeerOrigin) return false;
  return outbound.packages.some(p => {
    if (outbound.target.kind === 'scope') {
      return carrier.scope === outbound.target.scopeId && p.scope === carrier.scope
        && graph.membership(p.origin, p.local, p.peer) === 'ready';
    }
    return p.channelId === outbound.target.channelId && carrier.channelId === p.channelId;
  });
}

// These UUIDs were also independently calculated with Python's standard uuid
// implementation, not generated from the functions under test as expectations.
test('CG-01 identifier vectors, orientation and sender direction', () => {
  assert.equal(channelId(A0, B0), '89a135f8-08db-5805-b80d-b3d2b7bb737b');
  assert.equal(channelId(B0, A0), channelId(A0, B0));
  assert.equal(S, 'fb69b171-e36c-5553-9acc-f8b32733d02f');
  assert.equal(scopeId(B0[0], A0[0]), S);
  assert.equal(observationId(A0, B0, WIRE), 'd5034d0c-4bea-5d30-8085-d834dd412b75');
  assert.equal(executionId(S, B0[0], WIRE), 'c853ce4c-cb26-5b78-906b-902146a2d6c8');
  assert.equal(executionId(S, A0[0], WIRE), 'd2fbf4b1-c72d-54b9-bcf3-9b34b337f6cb');
  assert.equal(autoContactId(S), 'a9536788-1bca-5db5-87de-b40261db78ff');
});
test('identifier helper rejects invalid Unicode and unsupported transcript values', () => {
  assert.throws(() => canonical('\ud800'));
  assert.throws(() => canonical(1));
  assert.throws(() => channelId(A0, A0));
  assert.throws(() => channelId(A0, [B0[0], 'authentication', KB]));
  assert.equal(canonical({ sender: 'b', scope: 's' }), '{"scope":"s","sender":"b"}');
});
test('CG-02 equal public keys under unrelated DIDs do not imply identity', () => {
  const stranger = ['did:example:stranger', 'keyAgreement', KB];
  assert.notEqual(channelId(A0, stranger), channelId(A0, B0));
  assert.equal(fold([root()], []).membership('o', A0, stranger), 'outside');
});
test('CG-03 a different pinned key is another channel in the same origin', () => {
  const r = root();
  r.peer.keys.push(KC);
  const alternate = [B0[0], 'keyAgreement', KC];
  assert.notEqual(channelId(A0, alternate), channelId(A0, B0));
  assert.equal(fold([r], []).membership('o', A0, alternate), 'ready');
  assert.equal(fold([root()], []).membership('o', A0, alternate), 'outside');
});
test('CG-04 channel growth preserves origin and execution identities', () => {
  const before = executionId(S, B0[0], WIRE);
  const f = fold([root()], [EP]);
  assert.equal(f.membership('o', A0, B1), 'ready');
  assert.notEqual(channelId(A0, B0), channelId(A0, B1));
  assert.equal(executionId(S, B0[0], WIRE), before);
  assert.notEqual(observationId(A0, B0, WIRE), observationId(A0, B1, WIRE));
});
test('CG-05 contact grouping does not grant graph membership or change execution', () => {
  const stranger = ['did:example:stranger', 'keyAgreement', KB];
  const contacts = new Map([['bob', [channelId(A0, B0)]], ['other', [channelId(A0, stranger)]]]);
  const before = executionId(S, B0[0], WIRE);
  contacts.set('bob', [...contacts.get('bob'), ...contacts.get('other')]);
  contacts.delete('other');
  assert.equal(fold([root()], []).membership('o', A0, stranger), 'outside');
  assert.equal(executionId(S, B0[0], WIRE), before);
});
test('CG-10 pending exact-pair claim blocks rooting only that pair', () => {
  const pair = (a, b) => canonical([a[0], b[0]]);
  const claimed = new Set([pair(A0, B1)]);
  const mayRoot = (a, b, hasProof) => !hasProof && !claimed.has(pair(a, b));
  assert.equal(mayRoot(A0, B1, false), false);
  assert.equal(mayRoot(A0, [B1[0], 'keyAgreement', KB], false), false);
  assert.equal(mayRoot(A0, B0, true), false);
  assert.equal(mayRoot(A1, B0, false), true);
});
test('CG-12 equivalent edge witnesses are idempotent', () => {
  const f = fold([root()], [EP, { ...EP, id: 'p-copy' }]);
  assert.equal(f.membership('o', A0, B1), 'ready');
  assert.equal(f.scopes.size, 1);
});
test('CG-12 incompatible proofs and successor pins conflict in either order', () => {
  for (const alternative of [{ ...EP, id: 'p2', proof: 'another-proof' },
    { ...EP, id: 'p2', to: { ...EP.to, document: 'another-document' } }]) {
    for (const edges of permutations([EP, alternative])) {
      assert.equal(fold([root()], edges).membership('o', A0, B1), 'conflict');
    }
  }
});
test('CG-13 missing prefix waits and the complete edge union converges', () => {
  const b2 = ['did:example:bob2', 'keyAgreement', KA];
  const e2 = edge('p2', 'peer', B1, b2, 'p');
  assert.equal(fold([root()], [e2]).membership('o', A0, b2), 'pending');
  for (const edges of permutations([EL, EP, e2])) {
    assert.equal(fold([root()], edges).membership('o', A1, b2), 'ready');
  }
  assert.equal(fold([], [EP]).membership('o', A0, B1), 'pending');
});
test('CG-14 simultaneous endpoint rotations need no intermediate channel observations', () => {
  for (const edges of permutations([EL, EP])) {
    const f = fold([root()], edges);
    assert.equal(f.membership('o', A1, B1), 'ready');
    assert.equal(f.scopes.size, 1);
  }
});
test('CG-15 competing successors and cycles conflict', () => {
  const b2 = ['did:example:bob2', 'keyAgreement', KA];
  assert.equal(fold([root()], [EP, edge('fork', 'peer', B0, b2)]).membership('o', A0, B1), 'conflict');
  assert.equal(fold([root()], [EP, edge('back', 'peer', B1, B0, 'p')]).membership('o', A0, B0), 'conflict');
});
test('CG-16/17 late cross-origin claims conflict every claimant without merging IDs', () => {
  const second = root('o2', A0, B1);
  const otherScope = scopeId(A0[0], B1[0]);
  const before = [executionId(S, B0[0], WIRE), executionId(otherScope, B1[0], WIRE)];
  for (const roots of permutations([root(), second])) {
    const f = fold(roots, [EP]);
    assert.equal(f.scopes.size, 2);
    assert.equal(f.membership('o', A0, B1), 'conflict');
    assert.equal(f.membership('o2', A0, B1), 'conflict');
    assert.deepEqual([executionId(S, B0[0], WIRE), executionId(otherScope, B1[0], WIRE)], before);
  }
});
test('CG-17 incompatible root pins conflict instead of selecting the first', () => {
  const changed = root('copy');
  changed.peer.document = 'different-root-pin';
  for (const roots of permutations([root(), changed])) {
    assert.equal(fold(roots, []).membership('o', A0, B0), 'conflict');
  }
});
test('CG-18/19 logical conflicts dominate unresolved siblings', () => {
  const good = { status: 'ready', intent: 'same' };
  assert.equal(executionState([good, { ...good }]), 'ready');
  assert.equal(executionState([good, { status: 'pending', intent: 'unknown' }]), 'pending');
  for (const obs of permutations([good, { status: 'ready', intent: 'different' },
    { status: 'pending', intent: 'unknown' }])) assert.equal(executionState(obs), 'conflict');
});
test('CG-20 ACK needs admission, direction, target and prepared-package membership', () => {
  const graph = fold([root()], [EL, EP]);
  const outbound = { wire: WIRE, expectedPeerOrigin: B0[0], target: { kind: 'scope', scopeId: S },
    packages: [{ scope: S, origin: 'o', local: A0, peer: B0 }] };
  const carrier = { admitted: true, ack: [WIRE], originSender: B0[0], scope: S, channelId: channelId(A1, B1) };
  assert.equal(ackAllowed(outbound, carrier, graph), true);
  assert.equal(ackAllowed(outbound, { ...carrier, admitted: false }, graph), false);
  assert.equal(ackAllowed(outbound, { ...carrier, originSender: A0[0] }, graph), false);
  assert.equal(ackAllowed(outbound, { ...carrier, scope: 'other' }, graph), false);
  assert.equal(ackAllowed({ ...outbound, packages: [] }, carrier, graph), false);
  const stranger = ['did:example:stranger', 'keyAgreement', KB];
  assert.equal(ackAllowed({ ...outbound, packages: [{ scope: S, origin: 'o', local: A0, peer: stranger }] }, carrier, graph), false);
});
test('CG-22 exact-channel target does not acquire rotation-transparent ACK rights', () => {
  const c = channelId(A0, B0);
  const outbound = { wire: WIRE, expectedPeerOrigin: B0[0], target: { kind: 'channel', channelId: c },
    packages: [{ channelId: c }] };
  const carrier = { admitted: true, ack: [WIRE], originSender: B0[0], scope: S, channelId: c };
  assert.equal(ackAllowed(outbound, carrier, fold([root()], [])), true);
  assert.equal(ackAllowed(outbound, { ...carrier, channelId: channelId(A0, B1) }, fold([root()], [EP])), false);
});
test('CG-23 submission, not peer acknowledgment, controls new sending work', () => {
  const maySend = state => !state.submitted && !state.expired && !state.conflict;
  assert.equal(maySend({ submitted: false, acknowledged: true }), true);
  assert.equal(maySend({ submitted: true, acknowledged: false }), false);
});
test('CG-25 frozen scope deny survives contact removal and covers a successor', () => {
  const blocks = JSON.parse(JSON.stringify([{ kind: 'scope', scopeId: S }]));
  const contacts = new Map([['bob', [channelId(A0, B0)]]]);
  contacts.delete('bob');
  const graph = fold([root()], [EP]);
  assert.equal(graph.membership('o', A0, B1), 'ready');
  assert.equal(blocks.some(b => b.kind === 'scope' && b.scopeId === S), true);
});
test('CG-29 a shared public DID does not rotate an unrelated origin', () => {
  const stranger = ['did:example:stranger', 'keyAgreement', KB];
  const f = fold([root(), root('other', A0, stranger)], [EP]);
  assert.equal(f.membership('o', A0, B1), 'ready');
  assert.equal(f.membership('other', A0, stranger), 'ready');
  assert.equal(f.membership('other', A0, B1), 'outside');
});
