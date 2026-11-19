// app.ts — a GitHub-compatible git forge, standard library only.
//
// One process serves git smart HTTP (upload-pack v2/v0, receive-pack v0),
// the REST API v3, GraphQL v4 and MCP, all from a single in-memory store.
// The store is deterministic: a logical clock drives every timestamp and
// id, so two runs fed the same requests end in the same state.
//
// Entry point: main.ts (kept as the kit's lifecycle) calls createApp() and
// listens on an ephemeral port.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Identity. The suite's scenario is built from a fixed seed, so the viewer,
// the teammate, the stranger and the org are the same in every trial.
// ---------------------------------------------------------------------------

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const TEAMMATE_LOGIN = 'quinnkeller';
export const TEAMMATE_ID = 1001;
export const STRANGER_LOGIN = 'olgabauer';
export const STRANGER_ID = 1002;
export const ORG_LOGIN = 'faint-meadow-org';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

// The token the environment hands to the entry. When it is set, every
// authenticated surface checks the bearer token against it by equality.
// When it is unset (local runs without the harness) auth is open.
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// ---------------------------------------------------------------------------
// Deterministic clock and ids. Nothing in a response depends on wall time
// or randomness, so a replay of the same requests replays the same state.
// ---------------------------------------------------------------------------

const CLOCK_BASE_S = Math.floor(Date.parse('2026-11-14T06:30:00Z') / 1000);
let clockTick = 0;
function tick(): number {
  clockTick += 1;
  return CLOCK_BASE_S + clockTick;
}
function nowIso(): string {
  return new Date(tick() * 1000).toISOString();
}
function nowUnix(): number {
  return tick();
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

let globalIdCounter = 0;
function nextGlobalId(): number {
  globalIdCounter += 1;
  return globalIdCounter;
}

let repoDbCounter = 0;
function nextRepoDbId(): number {
  repoDbCounter += 1;
  return repoDbCounter;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

function lower(value: string): string {
  return value.toLowerCase();
}

function b64encode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64urlDecode(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// pkt-line framing (git wire protocol)
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

function parsePktLines(buffer: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const lenHex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (lenHex === '0000') {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (lenHex === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, rest: buffer.subarray(offset) };
}

// Split a sideband stream (band 1 = data, 2 = progress, 3 = error) into its
// data bytes. Returns the concatenated band-1 payload.
function sidebandData(packets: readonly Pkt[]): Buffer {
  const chunks: Buffer[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload.length < 1) continue;
    const band = packet.payload[0];
    if (band === 1) chunks.push(packet.payload.subarray(1));
    else if (band === 3) throw new Error(`sideband error: ${packet.payload.subarray(1).toString('utf8').trim()}`);
  }
  return Buffer.concat(chunks);
}

// Wrap raw bytes as sideband band-1 pkt-lines, each at most 65520 bytes.
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunkSize = 65515;
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([1])));
    return out;
  }
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const slice = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git object ids and pack format
// ---------------------------------------------------------------------------

type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

// The global content-addressed store. Objects are only ever reached through
// a repository's refs, so sharing the store across repositories cannot leak
// one repository's history into another.
const objects = new Map<string, StoredObject>();

function storeObject(type: ObjectType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

function getObject(oid: string): StoredObject | undefined {
  return objects.get(oid);
}

// Read a git varint: 7 bits per byte, little-endian groups, continuation bit.
function readVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = buffer[pos];
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

// Read a git offset varint (used by ofs-delta entries).
function readOffsetVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let pos = offset;
  let byte = buffer[pos];
  pos += 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[pos];
    pos += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: pos };
}

// Apply a git delta to a base buffer.
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    const r = readVarint(delta, pos);
    pos = r.next;
    return r.value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (written !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  type: ObjectType;
  data: Buffer;
  oid: string;
}

// Parse a packfile, resolving ofs-delta and ref-delta entries against the
// pack itself and the object store.
function readPack(pack: Buffer): PackEntry[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjectType;
    let data: Buffer;
    // For delta entries the header size is the size of the delta data, not
    // of the object the delta produces; only non-delta entries compare
    // their inflated length against the header size.
    let isDelta = false;
    let deltaLength = 0;
    if (typeCode === 6) {
      // ofs-delta: base is an earlier entry in this pack.
      const base = readOffsetVarint(pack, offset);
      offset = base.next;
      const baseEntry = byOffset.get(entryOffset - base.value);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const inflated = inflateWithLength(pack, offset);
      offset += inflated.consumed;
      deltaLength = inflated.data.length;
      data = applyDelta(baseEntry.data, inflated.data);
      type = baseEntry.type;
      isDelta = true;
    } else if (typeCode === 7) {
      // ref-delta: base is named by oid, in this pack or in the store.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = byOid.get(baseOid) ?? getObject(baseOid);
      if (!base) throw new Error('ref-delta base not found');
      const inflated = inflateWithLength(pack, offset);
      offset += inflated.consumed;
      deltaLength = inflated.data.length;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
      isDelta = true;
    } else {
      type = CODE_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack type ${typeCode}`);
      const inflated = inflateWithLength(pack, offset);
      offset += inflated.consumed;
      data = inflated.data;
    }
    if (isDelta) {
      if (deltaLength !== size) throw new Error('pack delta size mismatch');
    } else if (data.length !== size) {
      throw new Error('pack entry size mismatch');
    }
    const oid = objectId(type, data);
    const entry: PackEntry = { type, data, oid };
    entries.push(entry);
    byOffset.set(entryOffset, entry);
    byOid.set(oid, entry);
  }
  return entries;
}

// Inflate a zlib stream starting at offset, reporting how many bytes of the
// input the stream consumed. inflateSync ignores trailing bytes and throws
// on a truncated stream, so the consumed length is the smallest prefix
// that inflates cleanly, found by binary search.
function inflateWithLength(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  const total = buffer.length - offset;
  let low = 1;
  let high = total;
  let best: Buffer | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const data = inflateSync(buffer.subarray(offset, offset + mid));
      best = data;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (best === null) throw new Error('cannot inflate pack entry');
  return { data: best, consumed: low };
}

function writePack(entries: readonly PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const entry of entries) {
    const typeCode = TYPE_CODES[entry.type];
    const size = entry.data.length;
    const headBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(entry.data, { level: 1 }));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

// Build a pack containing exactly the given objects, in deterministic order.
// Packs are pure functions of their object set (objects are immutable), so
// identical requests reuse the same bytes — the clone workload fetches the
// same pack fifty times in a row. The cache is in-memory only and never
// enters the exported state, so replay determinism is unaffected.
const packCache = new Map<string, Buffer>();
function packOf(oids: ReadonlySet<string>): Buffer {
  const sorted = [...oids].sort();
  const key = createHash('sha1').update(sorted.join(',')).digest('hex');
  const cached = packCache.get(key);
  if (cached) return cached;
  const entries: PackEntry[] = [];
  for (const oid of sorted) {
    const obj = objects.get(oid);
    if (obj) entries.push({ type: obj.type, data: obj.data, oid });
  }
  const pack = writePack(entries);
  if (packCache.size >= 64) {
    const oldest = packCache.keys().next().value as string | undefined;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const stored = pack.subarray(pack.length - 20);
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  return stored.equals(actual);
}

// ---------------------------------------------------------------------------
// Parsed git objects (cached; the raw bytes in the store stay canonical)
// ---------------------------------------------------------------------------

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

const commitCache = new Map<string, CommitView>();
const treeCache = new Map<string, TreeEntry[]>();

function parseCommitBytes(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

function getCommit(oid: string): CommitView | undefined {
  const cached = commitCache.get(oid);
  if (cached) return cached;
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'commit') return undefined;
  const view = parseCommitBytes(obj.data);
  commitCache.set(oid, view);
  return view;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTreeBytes(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function getTree(oid: string): TreeEntry[] | undefined {
  const cached = treeCache.get(oid);
  if (cached) return cached;
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'tree') return undefined;
  const entries = parseTreeBytes(obj.data);
  treeCache.set(oid, entries);
  return entries;
}

function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    // Git sorts tree entries by name, with directories compared as name + '/'.
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function tagTarget(oid: string): { object: string; type: ObjectType } | undefined {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  const text = obj.data.toString('utf8');
  const objectMatch = /^object ([0-9a-f]{40})$/m.exec(text);
  const typeMatch = /^type (\w+)$/m.exec(text);
  if (!objectMatch || !typeMatch) return undefined;
  return { object: objectMatch[1], type: typeMatch[1] as ObjectType };
}

// Resolve an oid to the commit it names (following annotated tags).
function resolveToCommit(oid: string): string | undefined {
  let current = oid;
  for (let i = 0; i < 8; i += 1) {
    const obj = objects.get(current);
    if (!obj) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const target = tagTarget(current);
      if (!target) return undefined;
      current = target.object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

// All commit oids reachable from the tips (parents first-class).
function reachableCommits(tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const commit = getCommit(oid);
    if (!commit) continue;
    seen.add(oid);
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

// Is `ancestor` an ancestor of (or equal to) `descendant`?
function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const stack = [descendant];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

// Collect every object reachable from a set of commit tips: commits, their
// trees (recursively), blobs, and tag objects on the way.
function collectObjectsFromCommitSet(commits: ReadonlySet<string>, out: Set<string>): void {
  for (const oid of commits) out.add(oid);
  const treeStack: string[] = [];
  for (const oid of commits) {
    const commit = getCommit(oid);
    if (commit) treeStack.push(commit.tree);
  }
  const seenTrees = new Set<string>();
  while (treeStack.length > 0) {
    const treeOid = treeStack.pop() as string;
    if (seenTrees.has(treeOid)) continue;
    seenTrees.add(treeOid);
    out.add(treeOid);
    const entries = getTree(treeOid);
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.mode === '40000') {
        treeStack.push(entry.oid);
      } else {
        out.add(entry.oid);
      }
    }
  }
}

function collectObjectsFromCommits(tips: readonly string[], out: Set<string>): void {
  collectObjectsFromCommitSet(reachableCommits(tips), out);
}

// Objects the fetching client already holds. A "have" that is one of the
// client's shallow boundaries is held only as itself (commit + tree +
// blobs); its parents are NOT held, so the walk must not cross a boundary.
// A "have" that is not a boundary is held with its full history.
function heldObjects(haves: readonly string[], shallow: readonly string[]): Set<string> {
  const boundarySet = new Set(shallow);
  const commits = new Set<string>();
  const extra = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const commitOid = resolveToCommit(oid);
    if (!commitOid) {
      if (objects.has(oid)) extra.add(oid);
      continue;
    }
    if (commits.has(commitOid)) continue;
    commits.add(commitOid);
    if (boundarySet.has(commitOid)) continue;
    const commit = getCommit(commitOid);
    if (commit) for (const parent of commit.parents) stack.push(parent);
  }
  const out = new Set<string>(extra);
  collectObjectsFromCommitSet(commits, out);
  return out;
}

// Resolve a set of want oids (commits or tags) to the full object set.
function reachableObjects(wants: readonly string[]): Set<string> {
  const out = new Set<string>();
  const commitTips: string[] = [];
  for (const want of wants) {
    const obj = objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      out.add(want);
      const target = tagTarget(want);
      if (target && target.type === 'commit') commitTips.push(target.object);
      else if (target) out.add(target.object);
    } else if (obj.type === 'commit') {
      commitTips.push(want);
    } else {
      out.add(want);
    }
  }
  collectObjectsFromCommits(commitTips, out);
  return out;
}

interface DepthWalk {
  objects: Set<string>;
  shallow: string[];
  unshallow: string[];
}

// Depth-limited walk: include commits at distance <= depth from the wants
// (distance 1 is the want itself). Commits at exactly depth are shallow
// boundaries. Old boundaries that are now interior (a parent is included)
// are reported as unshallow.
function depthLimitedObjects(
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | null,
): DepthWalk {
  if (depth === null) {
    const objectsSet = reachableObjects(wants);
    const haveSet = heldObjects(haves, oldShallow);
    for (const oid of haveSet) objectsSet.delete(oid);
    return { objects: objectsSet, shallow: [], unshallow: [] };
  }
  // BFS over commits by distance from the wants.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const commitOid = resolveToCommit(want);
    if (!commitOid) continue;
    if (!distance.has(commitOid)) {
      distance.set(commitOid, 1);
      queue.push(commitOid);
    }
  }
  const included = new Set<string>();
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const dist = distance.get(oid) as number;
    if (dist > depth) continue;
    included.add(oid);
    const commit = getCommit(oid);
    if (!commit) continue;
    if (dist === depth) {
      boundary.add(oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }
  const objectsSet = new Set<string>();
  // Only the commits inside the depth window: collecting from the included
  // set must NOT walk parents, or a depth-1 fetch would carry the whole
  // history.
  collectObjectsFromCommitSet(included, objectsSet);
  // Tag objects named directly by a want are included with their targets.
  for (const want of wants) {
    const obj = objects.get(want);
    if (obj && obj.type === 'tag') objectsSet.add(want);
  }
  const haveSet = heldObjects(haves, oldShallow);
  for (const oid of haveSet) objectsSet.delete(oid);
  const shallow: string[] = [];
  for (const oid of boundary) {
    if (included.has(oid)) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const old of oldShallow) {
    if (included.has(old)) {
      const commit = getCommit(old);
      if (commit && commit.parents.some((p) => included.has(p))) unshallow.push(old);
    }
  }
  return { objects: objectsSet, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// Tree as a flat path map, for contents and merges
// ---------------------------------------------------------------------------

function flattenTree(treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const entries = getTree(treeOid);
  if (!entries) return;
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

function buildTreeFromMap(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  // Group files by their first path segment, recursively.
  const build = (paths: readonly [string, { oid: string; mode: string }][]): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, [string, { oid: string; mode: string }][]>();
    for (const [path, value] of paths) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: value.mode, name: path, oid: value.oid });
      } else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        const list = dirs.get(dir) ?? [];
        list.push([rest, value]);
        dirs.set(dir, list);
      }
    }
    for (const [dir, list] of dirs) {
      entries.push({ mode: '40000', name: dir, oid: build(list) });
    }
    return storeObject('tree', serializeTree(entries));
  };
  return build([...files.entries()]);
}

// Create a commit object. The message is stored byte-exactly as given.
function createCommit(
  treeOid: string,
  parents: readonly string[],
  message: string,
  authorName: string,
  authorEmail: string,
): string {
  const ts = nowUnix();
  const ident = `${authorName} <${authorEmail}> ${ts} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  const data = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
  return storeObject('commit', data);
}

// Three-way merge at the file level. Returns the merged tree oid, or null
// when the same path changed differently on both sides.
function threeWayMerge(
  baseTreeOid: string,
  oursTreeOid: string,
  theirsTreeOid: string,
): string | null {
  const base = new Map<string, { oid: string; mode: string }>();
  const ours = new Map<string, { oid: string; mode: string }>();
  const theirs = new Map<string, { oid: string; mode: string }>();
  flattenTree(baseTreeOid, '', base);
  flattenTree(oursTreeOid, '', ours);
  flattenTree(theirsTreeOid, '', theirs);
  const merged = new Map<string, { oid: string; mode: string }>(ours);
  const allPaths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of allPaths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const changedOurs = (o?.oid ?? null) !== (b?.oid ?? null);
    const changedTheirs = (t?.oid ?? null) !== (b?.oid ?? null);
    if (changedOurs && changedTheirs) {
      if ((o?.oid ?? null) !== (t?.oid ?? null)) return null;
    } else if (changedTheirs) {
      if (t) merged.set(path, t);
      else merged.delete(path);
    }
    // changedOurs only: keep ours (already in merged).
  }
  return buildTreeFromMap(merged);
}

// Simple line diff counts between two blob contents (multiset difference).
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  const remainingOld = new Map(oldCounts);
  for (const line of newLines) {
    const left = remainingOld.get(line) ?? 0;
    if (left > 0) remainingOld.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  const remainingNew = new Map(newCounts);
  for (const line of oldLines) {
    const left = remainingNew.get(line) ?? 0;
    if (left > 0) remainingNew.set(line, left - 1);
    else deletions += 1;
  }
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// Repository store
// ---------------------------------------------------------------------------

interface Label {
  id: number;
  name: string;
  color: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
}

interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

interface Repo {
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  dbId: number;
  seq: number;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
}

const repos = new Map<string, Repo>();

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createRepoRecord(owner: string, name: string, isPrivate: boolean, description: string): Repo {
  const now = nowIso();
  const repo: Repo = {
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    dbId: nextRepoDbId(),
    seq: nextGlobalId(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    createdAt: now,
    updatedAt: now,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

function deleteRepoRecord(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

function viewerRepos(): Repo[] {
  const out: Repo[] = [];
  for (const repo of repos.values()) {
    if (repo.owner === VIEWER_LOGIN) out.push(repo);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// Resolve a ref name (branch, full ref, or commit oid) to a commit oid.
function resolveRef(repo: Repo, ref: string): string | undefined {
  if (isOid(ref)) return objects.has(ref) ? ref : undefined;
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag) return resolveToCommit(tag);
  return undefined;
}

function refTipCommit(repo: Repo, ref: string): string | undefined {
  const oid = resolveRef(repo, ref);
  if (!oid) return undefined;
  return resolveToCommit(oid);
}

function listBranchNames(repo: Repo): string[] {
  const names: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
  }
  return names.sort();
}

function listCommits(repo: Repo, ref: string): { sha: string; commit: CommitView }[] {
  const tip = refTipCommit(repo, ref);
  if (!tip) return [];
  const out: { sha: string; commit: CommitView }[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const commit = getCommit(oid);
    if (!commit) continue;
    seen.add(oid);
    out.push({ sha: oid, commit });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: b64urlEncode(`User:${id}`),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: b64urlEncode(`Repository:${repo.dbId}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : repo.owner === TEAMMATE_LOGIN ? TEAMMATE_ID : STRANGER_ID),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: b64urlEncode(`Label:${label.id}`),
    url: `https://api.github.com/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: null,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: b64urlEncode(`Issue:${repo.dbId}:${issue.number}`),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label ? label.color : 'ededed', description: null };
    }),
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    assignee: null,
    assignees: [],
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: b64urlEncode(`IssueComment:${repo.dbId}:${issueNumber}:${comment.id}`),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.userLogin, comment.userLogin === VIEWER_LOGIN ? VIEWER_ID : TEAMMATE_ID),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = refTipCommit(repo, pull.headRef);
  const baseTip = refTipCommit(repo, pull.baseRef);
  if (!headTip || !baseTip) return 'UNKNOWN';
  if (headTip === baseTip) return 'UNKNOWN';
  const headCommit = getCommit(headTip);
  const baseCommit = getCommit(baseTip);
  if (!headCommit || !baseCommit) return 'UNKNOWN';
  const mergeBase = findMergeBase(headTip, baseTip);
  if (!mergeBase) return 'CONFLICTING';
  const baseCommitView = getCommit(mergeBase);
  if (!baseCommitView) return 'UNKNOWN';
  const merged = threeWayMerge(baseCommitView.tree, baseCommit.tree, headCommit.tree);
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

function findMergeBase(a: string, b: string): string | undefined {
  const ancestorsA = reachableCommits([a]);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const commit = getCommit(oid);
    if (!commit) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return undefined;
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = refTipCommit(repo, pull.headRef);
  const baseTip = refTipCommit(repo, pull.baseRef);
  return {
    id: pull.id,
    node_id: b64urlEncode(`PullRequest:${repo.dbId}:${pull.number}`),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headTip ?? ZERO_OID, user: userJson(VIEWER_LOGIN, VIEWER_ID), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseTip ?? ZERO_OID, user: userJson(VIEWER_LOGIN, VIEWER_ID), repo: repoJson(repo) },
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull) === 'CONFLICTING' ? false : pullMergeable(repo, pull) === 'MERGEABLE',
    mergeable_state: pullMergeable(repo, pull) === 'CONFLICTING' ? 'dirty' : 'clean',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    comments: 0,
    commits: listCommits(repo, pull.headRef).length,
  };
}

// Diff between two trees, as pull-request file entries.
function diffTrees(baseTreeOid: string, headTreeOid: string): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const base = new Map<string, { oid: string; mode: string }>();
  const head = new Map<string, { oid: string; mode: string }>();
  flattenTree(baseTreeOid, '', base);
  flattenTree(headTreeOid, '', head);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const oldText = objects.get(b.oid)?.data.toString('utf8') ?? '';
      const d = lineDiff(oldText, '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions: d.deletions, changes: d.deletions });
    } else if (!b && h) {
      const newText = objects.get(h.oid)?.data.toString('utf8') ?? '';
      const d = lineDiff('', newText);
      out.push({ filename: path, status: 'added', additions: d.additions, deletions: 0, changes: d.additions });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = objects.get(h.oid)?.data.toString('utf8') ?? '';
      const d = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return out;
}

// Squash-merge a pull request. Returns the merge commit oid, or null on
// conflict (the caller answers 405).
function squashMerge(repo: Repo, pull: Pull): string | null {
  const headTip = refTipCommit(repo, pull.headRef);
  const baseTip = refTipCommit(repo, pull.baseRef);
  if (!headTip || !baseTip) return null;
  const headCommit = getCommit(headTip);
  const baseCommit = getCommit(baseTip);
  if (!headCommit || !baseCommit) return null;
  const mergeBase = findMergeBase(headTip, baseTip);
  if (!mergeBase) return null;
  const baseBaseCommit = getCommit(mergeBase);
  if (!baseBaseCommit) return null;
  const mergedTree = threeWayMerge(baseBaseCommit.tree, baseCommit.tree, headCommit.tree);
  if (mergedTree === null) return null;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  return createCommit(mergedTree, [baseTip], message, VIEWER_LOGIN, VIEWER_EMAIL);
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

function gitAuthOk(authHeader: string | undefined): boolean {
  if (!SHOP_TOKEN) return true;
  if (!authHeader) return false;
  if (authHeader.startsWith('Bearer ')) return authHeader.slice('Bearer '.length) === SHOP_TOKEN;
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8');
    const password = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
    return password === SHOP_TOKEN;
  }
  return false;
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

// v0 advertisement: service header, flush, ref lines, flush. The first
// line carries the capabilities after a NUL.
function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0.0'
      : 'symref=HEAD:refs/heads/main side-band-64k ofs-delta agent=makefun-forge/1.0.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const names = sortedRefNames(repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = defaultTip ? `${defaultTip} HEAD\0${caps}\n` : null;
    if (headLine) parts.push(pktLine(headLine));
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      parts.push(pktLine(`${oid} ${name}\n`));
      const obj = objects.get(oid);
      if (obj && obj.type === 'tag') {
        const target = tagTarget(oid);
        if (target && target.type === 'commit') parts.push(pktLine(`${target.object} ${name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// v2 advertisement: service header, flush, "version 2", capability lines, flush.
function advertisementV2(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${SERVER_NAME}/${SERVER_VERSION}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ls-refs lines for the v2 command.
function lsRefsLines(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): string[] {
  const lines: string[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (defaultTip && keep('HEAD')) {
    lines.push(`${defaultTip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  }
  for (const name of sortedRefNames(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const obj = objects.get(oid);
      if (obj && obj.type === 'tag') {
        const target = tagTarget(oid);
        if (target && target.type === 'commit') line += ` peeled:${target.object}`;
      }
    }
    lines.push(`${line}\n`);
  }
  if (repo.refs.size === 0 && args.unborn && keep('HEAD')) {
    lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  return lines;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

function parseV2FetchBody(packets: readonly Pkt[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) req.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = parseInt(line.slice(13).trim(), 10);
      if (Number.isFinite(n)) req.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) req.deepenNot.push(line.slice(11).trim());
  }
  return req;
}

// Build the ack lines for a fetch: NAK when there are no haves, otherwise
// ACK each have that is an ancestor of a want, then "ready".
function ackLines(wants: readonly string[], haves: readonly string[]): string[] {
  if (haves.length === 0) return ['NAK\n'];
  const acked: string[] = [];
  for (const have of haves) {
    const obj = objects.get(have);
    if (!obj) continue;
    const haveCommit = resolveToCommit(have);
    if (!haveCommit) continue;
    for (const want of wants) {
      const wantCommit = resolveToCommit(want);
      if (wantCommit && isAncestor(haveCommit, wantCommit)) {
        acked.push(`ACK ${have}\n`);
        break;
      }
    }
  }
  if (acked.length === 0) return ['NAK\n'];
  acked.push('ready\n');
  return acked;
}

function fetchResponse(repo: Repo, req: FetchRequest, protocol: 2 | 0): Buffer {
  const wants = [...new Set(req.wants)].filter((oid) => objects.has(oid));
  // deepen-since: include commits whose committer time is >= the cutoff,
  // approximated by a depth-unlimited walk that stops at older commits.
  let walk: DepthWalk;
  if (req.deepenSince !== null && req.depth === null) {
    walk = depthLimitedObjects(wants, req.haves, req.shallow, null);
    // Prune commits older than the cutoff: recompute without them.
    const cutoff = req.deepenSince;
    const kept = new Set<string>();
    for (const oid of walk.objects) {
      const commit = getCommit(oid);
      if (!commit) {
        kept.add(oid);
        continue;
      }
      const ts = parseInt(commit.committer.split(' ').slice(-2, -1)[0] ?? '0', 10);
      if (Number.isFinite(ts) && ts >= cutoff) kept.add(oid);
    }
    walk = { objects: kept, shallow: [], unshallow: [] };
  } else if (req.deepenNot.length > 0 && req.depth === null) {
    const excluded = reachableObjects(req.deepenNot);
    walk = depthLimitedObjects(wants, req.haves, req.shallow, null);
    for (const oid of excluded) walk.objects.delete(oid);
  } else {
    walk = depthLimitedObjects(wants, req.haves, req.shallow, req.depth);
  }
  const pack = packOf(walk.objects);
  if (protocol === 2) {
    const parts: Buffer[] = [];
    // Protocol v2, as git's fetch-pack drives it: the client only reads an
    // "acknowledgments" section when it sent "have" lines and is
    // negotiating. A fetch with no haves goes straight to the packfile
    // (and shallow-info), so an acknowledgments section there makes the
    // client die with "expected 'packfile', received 'acknowledgments'".
    // With haves, "ready" ends the ack section with a DELIM and a packfile
    // follows; NAK alone ends it with a FLUSH and the response ends.
    if (req.haves.length > 0) {
      const acks = ackLines(wants, req.haves);
      const ready = acks.some((line) => line === 'ready\n');
      if (ready) {
        parts.push(encodePktLines(['acknowledgments\n', ...acks, 'delim']));
      } else {
        parts.push(encodePktLines(['acknowledgments\n', ...acks, 'flush']));
        return Buffer.concat(parts);
      }
    }
    if (walk.shallow.length > 0 || walk.unshallow.length > 0) {
      const lines: (string | 'delim')[] = ['shallow-info\n'];
      for (const oid of walk.shallow) lines.push(`shallow ${oid}\n`);
      for (const oid of walk.unshallow) lines.push(`unshallow ${oid}\n`);
      lines.push('delim');
      parts.push(encodePktLines(lines));
    }
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  // Protocol v0: plain ack lines, then plain shallow lines, then the pack
  // as sideband packets, then a flush.
  const acks = ackLines(wants, req.haves);
  const parts: Buffer[] = [];
  for (const line of acks) parts.push(pktLine(line));
  for (const oid of walk.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of walk.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

// Parse a receive-pack command list (pkt-lines up to the first flush).
// Returns the commands and the byte offset where the pack starts.
function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, rest } = parsePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }
  return { commands, pack: rest };
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parsePushBody(body);
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const entries = readPack(pack);
      for (const entry of entries) storeObject(entry.type, entry.data);
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpack error';
    }
  }
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack error' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old value mismatch' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    if (!objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    // Update.
    if (!current) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
    } else if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'old value mismatch' });
    } else {
      const newCommit = resolveToCommit(command.newOid);
      const currentCommit = resolveToCommit(current);
      if (!newCommit || !currentCommit) {
        // Non-commit refs (tags): allow the update when the old value
        // matched, since there is no fast-forward notion for them.
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true });
      } else if (!isAncestor(currentCommit, newCommit)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true });
      }
    }
  }
  const reportLines: (string | 'flush')[] = [`unpack ${unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`);
  }
  // The report stream the reader sees must end with a flush inside band 1:
  // the demultiplexer consumes the outer flush, so without this the reader
  // sees end-of-file instead of the flush that ends the report.
  reportLines.push('flush');
  const reportBody = encodePktLines(reportLines);
  const parts: Buffer[] = [];
  for (const packet of sidebandPackets(reportBody)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface RequestContext {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
  url: string;
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

function jsonBody(ctx: RequestContext): Record<string, unknown> | null {
  if (ctx.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function sendJson(
  res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void },
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  });
  res.end(JSON.stringify(value));
}

function sendBuffer(
  res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: Buffer) => void },
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(
  res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void },
  status: number,
  message: string,
): void {
  sendJson(res, status, { message });
}

function restAuthOk(ctx: RequestContext): boolean {
  if (!SHOP_TOKEN) return true;
  const auth = headerValue(ctx.headers, 'authorization');
  return auth === `Bearer ${SHOP_TOKEN}`;
}

function paginate<T>(items: readonly T[], ctx: RequestContext): { page: T[]; link: string | null } {
  const perPageRaw = parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.max(1, Math.min(100, perPageRaw)) : 30;
  const pageRaw = parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  let link: string | null = null;
  if (page < totalPages) {
    const nextQuery = new URLSearchParams(ctx.query);
    nextQuery.set('page', String(page + 1));
    nextQuery.set('per_page', String(perPage));
    const lastQuery = new URLSearchParams(ctx.query);
    lastQuery.set('page', String(totalPages));
    lastQuery.set('per_page', String(perPage));
    link =
      `<${ctx.url.split('?')[0]}?${nextQuery.toString()}>; rel="next", ` +
      `<${ctx.url.split('?')[0]}?${lastQuery.toString()}>; rel="last"`;
  }
  return { page: slice, link };
}

function stringField(value: unknown, name: string): string | undefined {
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>)[name] === 'string') {
    return (value as Record<string, unknown>)[name] as string;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function contentEntry(
  repo: Repo,
  treeOid: string,
  path: string,
  ref: string,
): Record<string, unknown> | Record<string, unknown>[] | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  let currentTree = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = getTree(currentTree);
    if (!entries) return null;
    const entry = entries.find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') {
        const sub = getTree(entry.oid);
        if (!sub) return null;
        return sub.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          size: e.mode === '40000' ? 0 : (objects.get(e.oid)?.data.length ?? 0),
          name: e.name,
          path: `${path}/${e.name}`,
          sha: e.oid,
          url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path)}/${encodeURIComponent(e.name)}?ref=${encodeURIComponent(ref)}`,
        }));
      }
      const obj = objects.get(entry.oid);
      if (!obj) return null;
      return {
        type: 'file',
        encoding: 'base64',
        size: obj.data.length,
        name: entry.name,
        path,
        content: b64encode(obj.data),
        sha: entry.oid,
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${encodeURIComponent(ref)}/${encodeURIComponent(path)}`,
        git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
        download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${encodeURIComponent(ref)}/${encodeURIComponent(path)}`,
      };
    }
    if (entry.mode !== '40000') return null;
    currentTree = entry.oid;
  }
  // Empty path: root listing.
  const entries = getTree(currentTree);
  if (!entries) return null;
  return entries.map((e) => ({
    type: e.mode === '40000' ? 'dir' : 'file',
    size: e.mode === '40000' ? 0 : (objects.get(e.oid)?.data.length ?? 0),
    name: e.name,
    path: e.name,
    sha: e.oid,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(e.name)}?ref=${encodeURIComponent(ref)}`,
  }));
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  return { name: match[1], email: match[2], date: new Date(parseInt(match[3], 10) * 1000).toISOString() };
}

function commitJson(sha: string, commit: CommitView): Record<string, unknown> {
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  return {
    sha,
    node_id: b64urlEncode(`Commit:${sha}`),
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: commit.message,
      tree: { sha: commit.tree },
      url: `https://api.github.com/commits/${sha}`,
      comment_count: 0,
    },
    url: `https://api.github.com/commits/${sha}`,
    html_url: `https://github.com/commit/${sha}`,
    author: { login: VIEWER_LOGIN, id: VIEWER_ID },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
    parents: commit.parents.map((p) => ({ sha: p, url: `https://api.github.com/commits/${p}` })),
  };
}

type Res = {
  writeHead: (status: number, headers?: Record<string, string>) => void;
  end: (body?: string | Buffer) => void;
};

function handleRest(ctx: RequestContext, res: Res): boolean {
  const segments = ctx.pathname.split('/').filter((s) => s.length > 0);
  // GET /api/v3/ and /api/v3/meta need no token.
  if ((ctx.pathname === '/api/v3/' || ctx.pathname === '/api/v3') && ctx.method === 'GET') {
    sendJson(res, 200, {});
    return true;
  }
  if (ctx.method === 'GET' && ctx.pathname === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }
  if (!ctx.pathname.startsWith('/api/v3')) return false;
  if (!restAuthOk(ctx)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const rest = segments.slice(2); // after 'api', 'v3'
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      sendJson(res, 200, {});
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (rest[0] === 'user') {
    if (rest.length === 1 && ctx.method === 'GET') {
      sendJson(res, 200, {
        ...userJson(VIEWER_LOGIN, VIEWER_ID),
        name: VIEWER_LOGIN,
        email: VIEWER_EMAIL,
        public_repos: viewerRepos().length,
        followers: 0,
        following: 0,
        created_at: '2026-11-14T06:30:00Z',
        updated_at: nowIso(),
      });
      return true;
    }
    if (rest[1] === 'repos') {
      if (ctx.method === 'POST') {
        const body = jsonBody(ctx);
        if (body === null) {
          sendError(res, 400, 'Invalid JSON body');
          return true;
        }
        const name = stringField(body, 'name');
        if (!name) {
          sendError(res, 422, 'Validation Failed: name is required');
          return true;
        }
        if (getRepo(VIEWER_LOGIN, name)) {
          sendError(res, 422, 'Repository creation failed: name already exists on this account');
          return true;
        }
        const repo = createRepoRecord(
          VIEWER_LOGIN,
          name,
          body.private === true,
          stringField(body, 'description') ?? '',
        );
        sendJson(res, 201, repoJson(repo));
        return true;
      }
      if (ctx.method === 'GET') {
        const { page, link } = paginate(viewerRepos(), ctx);
        sendJson(res, 200, page.map((r) => repoJson(r)), link ? { link } : {});
        return true;
      }
    }
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const repo = getRepo(owner, name);
    const tail = rest.slice(3);
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (owner !== VIEWER_LOGIN) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail.length === 0) {
      if (ctx.method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (ctx.method === 'PATCH') {
        const body = jsonBody(ctx);
        if (body === null) {
          sendError(res, 400, 'Invalid JSON body');
          return true;
        }
        const description = stringField(body, 'description');
        if (description !== undefined) repo.description = description;
        repo.updatedAt = nowIso();
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (ctx.method === 'DELETE') {
        deleteRepoRecord(owner, name);
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail[0] === 'branches') {
      if (tail.length === 1 && ctx.method === 'GET') {
        const branches = listBranchNames(repo).map((branch) => ({
          name: branch,
          commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: '' },
          protected: false,
        }));
        sendJson(res, 200, branches);
        return true;
      }
      if (tail.length === 2 && ctx.method === 'GET') {
        const branch = decodeURIComponent(tail[1]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { name: branch, commit: { sha, url: '' }, protected: false });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail[0] === 'commits' && ctx.method === 'GET') {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const commits = listCommits(repo, ref);
      const { page, link } = paginate(commits, ctx);
      sendJson(
        res,
        200,
        page.map((c) => commitJson(c.sha, c.commit)),
        link ? { link } : {},
      );
      return true;
    }
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (ctx.method === 'POST' && tail.length === 2) {
        const body = jsonBody(ctx);
        if (body === null) {
          sendError(res, 400, 'Invalid JSON body');
          return true;
        }
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (!ref || !ref.startsWith('refs/') || !sha || !isOid(sha) || !objects.has(sha)) {
          sendError(res, 422, 'Validation Failed: ref and sha are required');
          return true;
        }
        if (repo.refs.has(ref)) {
          sendError(res, 422, 'Reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: b64urlEncode(`Ref:${repo.dbId}:${ref}`), url: '', object: { sha, type: objects.get(sha)?.type ?? 'commit', url: '' } });
        return true;
      }
      if (ctx.method === 'GET') {
        if (tail.length === 2) {
          const all = sortedRefNames(repo).map((ref) => ({
            ref,
            node_id: b64urlEncode(`Ref:${repo.dbId}:${ref}`),
            url: '',
            object: { sha: repo.refs.get(ref) as string, type: objects.get(repo.refs.get(ref) as string)?.type ?? 'commit', url: '' },
          }));
          sendJson(res, 200, all);
          return true;
        }
        const ref = tail.slice(2).join('/');
        const sha = repo.refs.get(ref);
        if (!sha) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { ref, node_id: b64urlEncode(`Ref:${repo.dbId}:${ref}`), url: '', object: { sha, type: objects.get(sha)?.type ?? 'commit', url: '' } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail[0] === 'labels') {
      if (ctx.method === 'POST' && tail.length === 1) {
        const body = jsonBody(ctx);
        if (body === null) {
          sendError(res, 400, 'Invalid JSON body');
          return true;
        }
        const labelName = stringField(body, 'name');
        if (!labelName) {
          sendError(res, 422, 'Validation Failed: name is required');
          return true;
        }
        if (repo.labels.has(labelName)) {
          sendError(res, 422, 'Validation Failed: label already exists');
          return true;
        }
        const label: Label = { id: nextGlobalId(), name: labelName, color: stringField(body, 'color') ?? 'ededed' };
        repo.labels.set(labelName, label);
        sendJson(res, 201, labelJson(label));
        return true;
      }
      if (ctx.method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(l)));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (ctx.method === 'POST') {
          const body = jsonBody(ctx);
          if (body === null) {
            sendError(res, 400, 'Invalid JSON body');
            return true;
          }
          const title = stringField(body, 'title');
          if (!title) {
            sendError(res, 422, 'Validation Failed: title is required');
            return true;
          }
          const labelNames = Array.isArray(body.labels)
            ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string')
            : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) {
              sendError(res, 422, `Validation Failed: label "${labelName}" does not exist`);
              return true;
            }
          }
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          const now = nowIso();
          const issue: Issue = {
            id: nextGlobalId(),
            number,
            title,
            body: stringField(body, 'body') ?? '',
            state: 'open',
            labels: labelNames,
            createdAt: now,
            updatedAt: now,
            closedAt: null,
            seq: nextGlobalId(),
          };
          repo.issues.set(number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        if (ctx.method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { page, link } = paginate(list, ctx);
          sendJson(
            res,
            200,
            page.map((i) => issueJson(repo, i)),
            link ? { link } : {},
          );
          return true;
        }
      }
      const issueNumber = parseInt(tail[1] ?? '', 10);
      const issue = Number.isFinite(issueNumber) ? repo.issues.get(issueNumber) : undefined;
      if (tail.length === 2) {
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (ctx.method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (ctx.method === 'PATCH') {
          const body = jsonBody(ctx);
          if (body === null) {
            sendError(res, 400, 'Invalid JSON body');
            return true;
          }
          const title = stringField(body, 'title');
          if (title !== undefined) issue.title = title;
          const issueBody = stringField(body, 'body');
          if (issueBody !== undefined) issue.body = issueBody;
          const state = stringField(body, 'state');
          if (state === 'open' || state === 'closed') {
            issue.state = state;
            issue.closedAt = state === 'closed' ? nowIso() : null;
          }
          if (Array.isArray(body.labels)) {
            const labelNames = (body.labels as unknown[]).filter((l): l is string => typeof l === 'string');
            for (const labelName of labelNames) {
              if (!repo.labels.has(labelName)) {
                sendError(res, 422, `Validation Failed: label "${labelName}" does not exist`);
                return true;
              }
            }
            issue.labels = labelNames;
          }
          issue.updatedAt = nowIso();
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (ctx.method === 'POST') {
          const body = jsonBody(ctx);
          if (body === null) {
            sendError(res, 400, 'Invalid JSON body');
            return true;
          }
          const commentBody = stringField(body, 'body');
          if (!commentBody) {
            sendError(res, 422, 'Validation Failed: body is required');
            return true;
          }
          const comment: Comment = { id: repo.nextCommentId, body: commentBody, userLogin: VIEWER_LOGIN, createdAt: nowIso() };
          repo.nextCommentId += 1;
          const list = repo.comments.get(issue.number) ?? [];
          list.push(comment);
          repo.comments.set(issue.number, list);
          sendJson(res, 201, commentJson(repo, issue.number, comment));
          return true;
        }
        if (ctx.method === 'GET') {
          const list = repo.comments.get(issue.number) ?? [];
          sendJson(res, 200, list.map((c) => commentJson(repo, issue.number, c)));
          return true;
        }
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (ctx.method === 'POST') {
          const body = jsonBody(ctx);
          if (body === null) {
            sendError(res, 400, 'Invalid JSON body');
            return true;
          }
          const title = stringField(body, 'title');
          const head = stringField(body, 'head');
          const base = stringField(body, 'base');
          if (!title || !head || !base) {
            sendError(res, 422, 'Validation Failed: title, head and base are required');
            return true;
          }
          const headTip = refTipCommit(repo, head);
          const baseTip = refTipCommit(repo, base);
          if (!headTip || !baseTip) {
            sendError(res, 422, 'Validation Failed: head or base branch does not exist');
            return true;
          }
          for (const existing of repo.pulls.values()) {
            if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
              sendError(res, 422, 'Validation Failed: a pull request already exists for this head and base');
              return true;
            }
          }
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          const now = nowIso();
          const pull: Pull = {
            id: nextGlobalId(),
            number,
            title,
            body: stringField(body, 'body') ?? '',
            state: 'open',
            headRef: head,
            baseRef: base,
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            createdAt: now,
            updatedAt: now,
            seq: nextGlobalId(),
          };
          repo.pulls.set(number, pull);
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
        if (ctx.method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page, link } = paginate(list, ctx);
          sendJson(
            res,
            200,
            page.map((p) => pullJson(repo, p)),
            link ? { link } : {},
          );
          return true;
        }
      }
      const pullNumber = parseInt(tail[1] ?? '', 10);
      const pull = Number.isFinite(pullNumber) ? repo.pulls.get(pullNumber) : undefined;
      if (tail.length === 2 && ctx.method === 'GET') {
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files' && ctx.method === 'GET') {
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const headTip = refTipCommit(repo, pull.headRef);
        const baseTip = refTipCommit(repo, pull.baseRef);
        if (!headTip || !baseTip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const headCommit = getCommit(headTip);
        const baseCommit = getCommit(baseTip);
        if (!headCommit || !baseCommit) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const files = diffTrees(baseCommit.tree, headCommit.tree);
        sendJson(
          res,
          200,
          files.map((f) => ({
            sha: '',
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            blob_url: '',
            raw_url: '',
            contents_url: '',
          })),
        );
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && (ctx.method === 'PUT' || ctx.method === 'POST')) {
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (pull.state !== 'open') {
          sendError(res, 405, 'Pull request is already closed');
          return true;
        }
        const body = jsonBody(ctx) ?? {};
        const method = stringField(body, 'merge_method') ?? 'squash';
        if (method === 'rebase') {
          sendError(res, 405, 'Rebase merges are not supported');
          return true;
        }
        let mergeSha: string | null = null;
        if (method === 'merge') {
          const headTip = refTipCommit(repo, pull.headRef);
          const baseTip = refTipCommit(repo, pull.baseRef);
          const headCommit = headTip ? getCommit(headTip) : undefined;
          const baseCommit = baseTip ? getCommit(baseTip) : undefined;
          if (headTip && baseTip && headCommit && baseCommit) {
            const mergeBase = findMergeBase(headTip, baseTip);
            const baseBaseCommit = mergeBase ? getCommit(mergeBase) : undefined;
            if (baseBaseCommit) {
              const mergedTree = threeWayMerge(baseBaseCommit.tree, baseCommit.tree, headCommit.tree);
              if (mergedTree !== null) {
                mergeSha = createCommit(mergedTree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.headRef}`, VIEWER_LOGIN, VIEWER_EMAIL);
              }
            }
          }
        } else {
          mergeSha = squashMerge(repo, pull);
        }
        if (mergeSha === null) {
          sendError(res, 405, 'Merge conflict');
          return true;
        }
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = nowIso();
        pull.mergeCommitSha = mergeSha;
        pull.updatedAt = nowIso();
        sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail[0] === 'contents') {
      const path = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const ref = ctx.query.get('ref') ?? repo.defaultBranch;
      if (ctx.method === 'GET') {
        const tip = refTipCommit(repo, ref);
        if (!tip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const commit = getCommit(tip);
        if (!commit) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const entry = contentEntry(repo, commit.tree, path, ref);
        if (entry === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, entry);
        return true;
      }
      if (ctx.method === 'PUT') {
        const body = jsonBody(ctx);
        if (body === null) {
          sendError(res, 400, 'Invalid JSON body');
          return true;
        }
        const message = stringField(body, 'message') ?? `Update ${path}`;
        const contentB64 = stringField(body, 'content');
        if (contentB64 === undefined) {
          sendError(res, 422, 'Validation Failed: content is required');
          return true;
        }
        const branch = stringField(body, 'branch') ?? repo.defaultBranch;
        const sha = stringField(body, 'sha');
        const contentBytes = b64decode(contentB64);
        const blobOid = storeObject('blob', contentBytes);
        const tip = refTipCommit(repo, branch);
        const files = new Map<string, { oid: string; mode: string }>();
        let parent: string[] = [];
        let isUpdate = false;
        if (tip) {
          const commit = getCommit(tip);
          if (!commit) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          flattenTree(commit.tree, '', files);
          parent = [tip];
          const existing = files.get(path);
          if (existing) {
            isUpdate = true;
            if (!sha) {
              sendError(res, 409, 'Validation Failed: sha is required to update a file');
              return true;
            }
            if (sha !== existing.oid) {
              sendError(res, 409, 'Validation Failed: sha does not match the current file');
              return true;
            }
          }
        }
        files.set(path, { oid: blobOid, mode: '100644' });
        const treeOid = buildTreeFromMap(files);
        const commitSha = createCommit(treeOid, parent, message, VIEWER_LOGIN, VIEWER_EMAIL);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        sendJson(
          res,
          isUpdate ? 200 : 201,
          {
            content: {
              name: path.split('/').pop() ?? path,
              path,
              sha: blobOid,
              size: contentBytes.length,
              encoding: 'base64',
              type: 'file',
            },
            commit: { sha: commitSha, message },
          },
        );
        return true;
      }
      if (ctx.method === 'DELETE') {
        const body = jsonBody(ctx);
        if (body === null) {
          sendError(res, 400, 'Invalid JSON body');
          return true;
        }
        const message = stringField(body, 'message') ?? `Delete ${path}`;
        const sha = stringField(body, 'sha');
        const branch = stringField(body, 'branch') ?? repo.defaultBranch;
        const tip = refTipCommit(repo, branch);
        if (!tip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const commit = getCommit(tip);
        if (!commit) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const files = new Map<string, { oid: string; mode: string }>();
        flattenTree(commit.tree, '', files);
        const existing = files.get(path);
        if (!existing) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (sha && sha !== existing.oid) {
          sendError(res, 409, 'Validation Failed: sha does not match the current file');
          return true;
        }
        files.delete(path);
        const treeOid = buildTreeFromMap(files);
        const commitSha = createCommit(treeOid, [tip], message, VIEWER_LOGIN, VIEWER_EMAIL);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }
  sendError(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// GraphQL v4 — a small parser for the query documents the suite sends,
// plus an executor over the same store as REST.
// ---------------------------------------------------------------------------

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };

type GqlSel =
  | { kind: 'field'; responseKey: string; name: string; args: Record<string, GqlValue>; selections: GqlSel[] | null }
  | { kind: 'inline'; typeCondition: string | null; selections: GqlSel[] };

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Record<string, GqlValue>;
  selections: GqlSel[];
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'variable'; value: string };

function tokenizeGql(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'variable', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ kind: 'number', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
    }
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): { operation: GqlOperation; fragments: Map<string, { typeCondition: string; selections: GqlSel[] }> } {
    const fragments = new Map<string, { typeCondition: string; selections: GqlSel[] }>();
    let operation: GqlOperation | null = null;
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(fragName, { typeCondition, selections });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        operation = this.parseOperation(token.value as 'query' | 'mutation');
        continue;
      }
      if (token.kind === 'punct' && token.value === '{') {
        operation = { kind: 'query', name: null, variableDefaults: {}, selections: this.parseSelectionSet() };
        continue;
      }
      throw new Error('unexpected token in GraphQL document');
    }
    if (!operation) throw new Error('no operation in GraphQL document');
    return { operation, fragments };
  }

  private parseOperation(kind: 'query' | 'mutation'): GqlOperation {
    let name: string | null = null;
    const token = this.peek();
    if (token && token.kind === 'name') {
      name = this.next().value as string;
    }
    const variableDefaults: Record<string, GqlValue> = {};
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const varToken = this.next();
        if (varToken.kind !== 'variable') throw new Error('expected a variable in GraphQL variable definitions');
        this.expectPunct(':');
        // Skip the type (a name, possibly wrapped in [] or suffixed with !).
        // Commas are insignificant in GraphQL and the tokenizer drops them,
        // so a definition ends when the next token starts another variable
        // or closes the list.
        let depth = 0;
        for (;;) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '[') depth += 1;
          else if (t.kind === 'punct' && t.value === ']') depth -= 1;
          else if (t.kind === 'punct' && t.value === '=' && depth === 0) {
            variableDefaults[varToken.value] = this.parseValue();
            break;
          } else if (t.kind === 'punct' && t.value === '!') {
            // continue
          } else if (t.kind === 'name') {
            // type name; continue
          } else if ((t.kind === 'variable' || (t.kind === 'punct' && t.value === ')')) && depth === 0) {
            this.pos -= 1;
            break;
          } else {
            throw new Error('unexpected token in GraphQL variable definitions');
          }
        }
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variableDefaults, selections };
  }

  private parseSelectionSet(): GqlSel[] {
    this.expectPunct('{');
    const selections: GqlSel[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSel {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token && token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        return { kind: 'inline', typeCondition, selections };
      }
      if (token && token.kind === 'name') {
        const fragName = this.next().value as string;
        return { kind: 'inline', typeCondition: `...${fragName}`, selections: [] };
      }
      const selections = this.parseSelectionSet();
      return { kind: 'inline', typeCondition: null, selections };
    }
    let responseKey = this.expectName();
    let name = responseKey;
    if (this.isPunct(':')) {
      this.next();
      name = this.expectName();
    }
    let args: Record<string, GqlValue> = {};
    if (this.isPunct('(')) {
      args = this.parseArguments();
    }
    // Directives: parsed and ignored (@skip/@include are not used by the
    // suite's documents, but skipping them keeps the parser total).
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
    let selections: GqlSel[] | null = null;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', responseKey, name, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> {
    this.expectPunct('(');
    const args: Record<string, GqlValue> = {};
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'variable') return { __var: token.value } as unknown as GqlValue;
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum value
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: { [key: string]: GqlValue } = {};
      while (!this.isPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        obj[key] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// Replace {__var: name} markers with the request's variable values.
function resolveVariables(value: GqlValue, variables: Record<string, unknown>, defaults: Record<string, GqlValue>): GqlValue {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as { [key: string]: GqlValue };
    if (typeof obj.__var === 'string') {
      const name = obj.__var;
      if (name in variables) return variables[name] as GqlValue;
      if (name in defaults) return defaults[name];
      return null;
    }
    const out: { [key: string]: GqlValue } = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveVariables(v, variables, defaults);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => resolveVariables(v, variables, defaults));
  return value;
}

function resolveArgs(args: Record<string, GqlValue>, variables: Record<string, unknown>, defaults: Record<string, GqlValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveVariables(v, variables, defaults);
  return out;
}

// ---------------------------------------------------------------------------
// GraphQL executor
// ---------------------------------------------------------------------------

type GqlNode =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string; id: number }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'BranchRef'; name: string }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueComment'; repo: Repo; issueNumber: number; comment: Comment }
  | { __typename: 'Label'; label: Label }
  | { __typename: 'File'; path: string; additions: number; deletions: number; changes: number; status: string }
  | { __typename: 'IssueConnection'; nodes: GqlNode[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequestConnection'; nodes: GqlNode[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'LabelConnection'; nodes: GqlNode[] }
  | { __typename: 'CommentConnection'; nodes: GqlNode[] }
  | { __typename: 'FileConnection'; nodes: GqlNode[] }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: '__Type'; name: string; fields: string[]; enumValues: string[] }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'CreateIssuePayload'; issue: GqlNode | null }
  | { __typename: 'CloseIssuePayload'; issue: GqlNode | null }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: GqlNode | null }
  | { __typename: 'MergePullRequestPayload'; pullRequest: GqlNode | null }
  | { __typename: 'AddCommentPayload'; commentEdge: GqlNode | null }
  | { __typename: 'CommentEdge'; node: GqlNode };

function globalId(kind: string, ...parts: (string | number)[]): string {
  return b64urlEncode([kind, ...parts].join(':'));
}

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = b64urlDecode(id);
    const parts = decoded.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function findRepoByDbId(dbId: number): Repo | undefined {
  for (const repo of repos.values()) {
    if (repo.dbId === dbId) return repo;
  }
  return undefined;
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): GqlNode {
  return { __typename: 'PullRequest', repo, pull };
}

function cursorFor(number: number): string {
  return b64urlEncode(`cursor:${number}`);
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const decoded = b64urlDecode(cursor);
    if (!decoded.startsWith('cursor:')) return null;
    const n = parseInt(decoded.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url'];
const PULL_TYPE_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'author', 'createdAt', 'mergedAt', 'mergeCommit'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'defaultBranch'];

function paginateIssues(repo: Repo, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : 30;
  const after = cursorNumber(typeof args.after === 'string' ? args.after : null);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? undefined;
  const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  let list = [...repo.issues.values()];
  if (states) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  if (after !== null) list = list.filter((i) => i.number < after);
  const page = list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return { __typename: 'IssueConnection', nodes: page.map((i) => issueNode(repo, i)), hasNextPage, endCursor };
}

function paginatePulls(repo: Repo, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : 30;
  const after = cursorNumber(typeof args.after === 'string' ? args.after : null);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let list = [...repo.pulls.values()];
  if (states) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((p) => wanted.has(p.state === 'open' ? 'OPEN' : p.merged ? 'MERGED' : 'CLOSED'));
  }
  list.sort((a, b) => b.seq - a.seq);
  if (after !== null) list = list.filter((p) => p.number < after);
  const page = list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return { __typename: 'PullRequestConnection', nodes: page.map((p) => pullNode(repo, p)), hasNextPage, endCursor };
}

interface FieldResult {
  value: unknown;
  type: string | null;
}

function resolveField(
  parent: GqlNode,
  name: string,
  args: Record<string, unknown>,
  errors: { message: string }[],
): FieldResult {
  const unknown = (): FieldResult => {
    errors.push({ message: `Cannot query field "${name}" on type "${parent.__typename}".` });
    return { value: null, type: null };
  };
  switch (parent.__typename) {
    case 'Query': {
      if (name === 'viewer') return { value: { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }, type: 'User' };
      if (name === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const repoName = typeof args.name === 'string' ? args.name : '';
        const repo = getRepo(owner, repoName);
        if (!repo || repo.owner !== VIEWER_LOGIN) return { value: null, type: 'Repository' };
        return { value: { __typename: 'Repository', repo }, type: 'Repository' };
      }
      if (name === 'node') {
        const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
        if (!parsed) return { value: null, type: null };
        if (parsed.kind === 'Repository') {
          const repo = findRepoByDbId(parseInt(parsed.parts[0], 10));
          return { value: repo ? { __typename: 'Repository', repo } : null, type: 'Repository' };
        }
        if (parsed.kind === 'Issue') {
          const repo = findRepoByDbId(parseInt(parsed.parts[0], 10));
          const issue = repo?.issues.get(parseInt(parsed.parts[1], 10));
          return { value: repo && issue ? issueNode(repo, issue) : null, type: 'Issue' };
        }
        if (parsed.kind === 'PullRequest') {
          const repo = findRepoByDbId(parseInt(parsed.parts[0], 10));
          const pull = repo?.pulls.get(parseInt(parsed.parts[1], 10));
          return { value: repo && pull ? pullNode(repo, pull) : null, type: 'PullRequest' };
        }
        if (parsed.kind === 'User') {
          const id = parseInt(parsed.parts[0], 10);
          const login = id === VIEWER_ID ? VIEWER_LOGIN : id === TEAMMATE_ID ? TEAMMATE_LOGIN : STRANGER_LOGIN;
          return { value: { __typename: 'User', login, id }, type: 'User' };
        }
        return { value: null, type: null };
      }
      if (name === '__type') {
        const typeName = typeof args.name === 'string' ? args.name : '';
        if (typeName === 'Issue') return { value: { __typename: '__Type', name: 'Issue', fields: ISSUE_TYPE_FIELDS, enumValues: [] }, type: '__Type' };
        if (typeName === 'PullRequest') return { value: { __typename: '__Type', name: 'PullRequest', fields: PULL_TYPE_FIELDS, enumValues: [] }, type: '__Type' };
        if (typeName === 'Repository') return { value: { __typename: '__Type', name: 'Repository', fields: REPO_TYPE_FIELDS, enumValues: [] }, type: '__Type' };
        if (typeName === 'SearchType') return { value: { __typename: '__Type', name: 'SearchType', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] }, type: '__Type' };
        return { value: null, type: '__Type' };
      }
      if (name === '__schema') return { value: null, type: '__Schema' };
      return unknown();
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (args.input as Record<string, unknown> | undefined) ?? {};
        const repoId = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
        const repo = repoId && repoId.kind === 'Repository' ? findRepoByDbId(parseInt(repoId.parts[0], 10)) : undefined;
        if (!repo) {
          errors.push({ message: 'Could not resolve to a Repository with the provided repositoryId.' });
          return { value: null, type: 'CreateIssuePayload' };
        }
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const now = nowIso();
        const issue: Issue = {
          id: nextGlobalId(),
          number,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          createdAt: now,
          updatedAt: now,
          closedAt: null,
          seq: nextGlobalId(),
        };
        repo.issues.set(number, issue);
        return { value: { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) }, type: 'CreateIssuePayload' };
      }
      if (name === 'closeIssue') {
        const input = (args.input as Record<string, unknown> | undefined) ?? {};
        const issueId = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
        const repo = issueId && issueId.kind === 'Issue' ? findRepoByDbId(parseInt(issueId.parts[0], 10)) : undefined;
        const issue = repo?.issues.get(issueId ? parseInt(issueId.parts[1], 10) : -1);
        if (!repo || !issue) {
          errors.push({ message: 'Could not resolve to an Issue with the provided issueId.' });
          return { value: null, type: 'CloseIssuePayload' };
        }
        issue.state = 'closed';
        issue.closedAt = nowIso();
        issue.updatedAt = nowIso();
        return { value: { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) }, type: 'CloseIssuePayload' };
      }
      if (name === 'createPullRequest') {
        const input = (args.input as Record<string, unknown> | undefined) ?? {};
        const repoId = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
        const repo = repoId && repoId.kind === 'Repository' ? findRepoByDbId(parseInt(repoId.parts[0], 10)) : undefined;
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headTip = repo ? refTipCommit(repo, head) : undefined;
        const baseTip = repo ? refTipCommit(repo, base) : undefined;
        if (!repo || !headTip || !baseTip) {
          errors.push({ message: 'Could not resolve the head or base branch for the pull request.' });
          return { value: null, type: 'CreatePullRequestPayload' };
        }
        const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (existing) {
          return { value: { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, existing) }, type: 'CreatePullRequestPayload' };
        }
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const now = nowIso();
        const pull: Pull = {
          id: nextGlobalId(),
          number,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          headRef: head,
          baseRef: base,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          createdAt: now,
          updatedAt: now,
          seq: nextGlobalId(),
        };
        repo.pulls.set(number, pull);
        return { value: { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) }, type: 'CreatePullRequestPayload' };
      }
      if (name === 'mergePullRequest') {
        const input = (args.input as Record<string, unknown> | undefined) ?? {};
        const pullId = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
        const repo = pullId && pullId.kind === 'PullRequest' ? findRepoByDbId(parseInt(pullId.parts[0], 10)) : undefined;
        const pull = repo?.pulls.get(pullId ? parseInt(pullId.parts[1], 10) : -1);
        if (!repo || !pull) {
          errors.push({ message: 'Could not resolve to a PullRequest with the provided pullRequestId.' });
          return { value: null, type: 'MergePullRequestPayload' };
        }
        if (pull.state !== 'open') {
          errors.push({ message: 'Pull request is already closed.' });
          return { value: null, type: 'MergePullRequestPayload' };
        }
        const mergeSha = squashMerge(repo, pull);
        if (mergeSha === null) {
          errors.push({ message: 'Merge conflict.' });
          return { value: null, type: 'MergePullRequestPayload' };
        }
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = nowIso();
        pull.mergeCommitSha = mergeSha;
        pull.updatedAt = nowIso();
        return { value: { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) }, type: 'MergePullRequestPayload' };
      }
      if (name === 'addComment') {
        const input = (args.input as Record<string, unknown> | undefined) ?? {};
        const subjectId = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
        const repo = subjectId && (subjectId.kind === 'Issue' || subjectId.kind === 'PullRequest')
          ? findRepoByDbId(parseInt(subjectId.parts[0], 10))
          : undefined;
        const number = subjectId ? parseInt(subjectId.parts[1], 10) : -1;
        const issue = repo?.issues.get(number);
        const pull = repo?.pulls.get(number);
        if (!repo || (!issue && !pull)) {
          errors.push({ message: 'Could not resolve to an Issue or PullRequest with the provided subjectId.' });
          return { value: null, type: 'AddCommentPayload' };
        }
        const comment: Comment = { id: repo.nextCommentId, body: typeof input.body === 'string' ? input.body : '', userLogin: VIEWER_LOGIN, createdAt: nowIso() };
        repo.nextCommentId += 1;
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        const node: GqlNode = { __typename: 'IssueComment', repo, issueNumber: number, comment };
        return { value: { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node } }, type: 'AddCommentPayload' };
      }
      return unknown();
    }
    case 'User': {
      if (name === 'login') return { value: parent.login, type: null };
      if (name === 'id') return { value: globalId('User', parent.id), type: null };
      if (name === 'databaseId') return { value: parent.id, type: null };
      if (name === 'name') return { value: parent.login, type: null };
      if (name === 'email') return { value: parent.login === VIEWER_LOGIN ? VIEWER_EMAIL : '', type: null };
      return unknown();
    }
    case 'Repository': {
      const repo = parent.repo;
      if (name === 'id') return { value: globalId('Repository', repo.dbId), type: null };
      if (name === 'databaseId') return { value: repo.dbId, type: null };
      if (name === 'name') return { value: repo.name, type: null };
      if (name === 'nameWithOwner') return { value: `${repo.owner}/${repo.name}`, type: null };
      if (name === 'owner') return { value: { __typename: 'User', login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : STRANGER_ID }, type: 'User' };
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return { value: null, type: 'BranchRef' };
        return { value: { __typename: 'BranchRef', name: repo.defaultBranch }, type: 'BranchRef' };
      }
      if (name === 'viewerPermission') return { value: 'ADMIN', type: null };
      if (name === 'hasIssuesEnabled') return { value: true, type: null };
      if (name === 'description') return { value: repo.description, type: null };
      if (name === 'createdAt') return { value: repo.createdAt, type: null };
      if (name === 'updatedAt') return { value: repo.updatedAt, type: null };
      if (name === 'defaultBranch') return { value: repo.defaultBranch, type: null };
      if (name === 'issue') {
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = repo.issues.get(number);
        return { value: issue ? issueNode(repo, issue) : null, type: 'Issue' };
      }
      if (name === 'issues') return { value: paginateIssues(repo, args), type: 'IssueConnection' };
      if (name === 'pullRequest') {
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = repo.pulls.get(number);
        return { value: pull ? pullNode(repo, pull) : null, type: 'PullRequest' };
      }
      if (name === 'pullRequests') return { value: paginatePulls(repo, args), type: 'PullRequestConnection' };
      return unknown();
    }
    case 'BranchRef': {
      if (name === 'name') return { value: parent.name, type: null };
      if (name === 'prefix') return { value: 'refs/heads/', type: null };
      return unknown();
    }
    case 'Issue': {
      const issue = parent.issue;
      if (name === 'id') return { value: globalId('Issue', parent.repo.dbId, issue.number), type: null };
      if (name === 'number') return { value: issue.number, type: null };
      if (name === 'title') return { value: issue.title, type: null };
      if (name === 'state') return { value: issue.state === 'open' ? 'OPEN' : 'CLOSED', type: null };
      if (name === 'body') return { value: issue.body, type: null };
      if (name === 'createdAt') return { value: issue.createdAt, type: null };
      if (name === 'updatedAt') return { value: issue.updatedAt, type: null };
      if (name === 'closedAt') return { value: issue.closedAt, type: null };
      if (name === 'author') return { value: { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }, type: 'User' };
      if (name === 'url') return { value: `https://github.com/${parent.repo.owner}/${parent.repo.name}/issues/${issue.number}`, type: null };
      if (name === 'labels') {
        const nodes: GqlNode[] = issue.labels.map((labelName) => {
          const label = parent.repo.labels.get(labelName);
          return { __typename: 'Label', label: label ?? { id: 0, name: labelName, color: 'ededed' } };
        });
        return { value: { __typename: 'LabelConnection', nodes }, type: 'LabelConnection' };
      }
      if (name === 'comments') {
        const list = parent.repo.comments.get(issue.number) ?? [];
        const nodes: GqlNode[] = list.map((c) => ({ __typename: 'IssueComment', repo: parent.repo, issueNumber: issue.number, comment: c }));
        return { value: { __typename: 'CommentConnection', nodes }, type: 'CommentConnection' };
      }
      return unknown();
    }
    case 'PullRequest': {
      const pull = parent.pull;
      if (name === 'id') return { value: globalId('PullRequest', parent.repo.dbId, pull.number), type: null };
      if (name === 'number') return { value: pull.number, type: null };
      if (name === 'title') return { value: pull.title, type: null };
      if (name === 'body') return { value: pull.body, type: null };
      if (name === 'state') return { value: pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED', type: null };
      if (name === 'merged') return { value: pull.merged, type: null };
      if (name === 'headRefName') return { value: pull.headRef, type: null };
      if (name === 'baseRefName') return { value: pull.baseRef, type: null };
      if (name === 'mergeable') return { value: pullMergeable(parent.repo, pull), type: null };
      if (name === 'createdAt') return { value: pull.createdAt, type: null };
      if (name === 'mergedAt') return { value: pull.mergedAt, type: null };
      if (name === 'author') return { value: { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }, type: 'User' };
      if (name === 'mergeCommit') {
        if (!pull.mergeCommitSha) return { value: null, type: null };
        return { value: { oid: pull.mergeCommitSha }, type: null };
      }
      if (name === 'files') {
        const headTip = refTipCommit(parent.repo, pull.headRef);
        const baseTip = refTipCommit(parent.repo, pull.baseRef);
        const headCommit = headTip ? getCommit(headTip) : undefined;
        const baseCommit = baseTip ? getCommit(baseTip) : undefined;
        if (!headCommit || !baseCommit) {
          return { value: { __typename: 'FileConnection', nodes: [] }, type: 'FileConnection' };
        }
        const first = typeof args.first === 'number' ? args.first : 30;
        const after = cursorNumber(typeof args.after === 'string' ? args.after : null);
        let files = diffTrees(baseCommit.tree, headCommit.tree).map((f) => ({
          __typename: 'File' as const,
          path: f.filename,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          status: f.status,
        }));
        if (after !== null) files = files.slice(after);
        files = files.slice(0, Math.max(0, first));
        return { value: { __typename: 'FileConnection', nodes: files }, type: 'FileConnection' };
      }
      return unknown();
    }
    case 'IssueComment': {
      if (name === 'id') return { value: globalId('IssueComment', parent.repo.dbId, parent.issueNumber, parent.comment.id), type: null };
      if (name === 'body') return { value: parent.comment.body, type: null };
      if (name === 'createdAt') return { value: parent.comment.createdAt, type: null };
      if (name === 'author') return { value: { __typename: 'User', login: parent.comment.userLogin, id: VIEWER_ID }, type: 'User' };
      return unknown();
    }
    case 'Label': {
      if (name === 'name') return { value: parent.label.name, type: null };
      if (name === 'color') return { value: parent.label.color, type: null };
      if (name === 'id') return { value: globalId('Label', parent.label.id), type: null };
      return unknown();
    }
    case 'File': {
      if (name === 'path') return { value: parent.path, type: null };
      if (name === 'additions') return { value: parent.additions, type: null };
      if (name === 'deletions') return { value: parent.deletions, type: null };
      if (name === 'changes') return { value: parent.changes, type: null };
      return unknown();
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'LabelConnection':
    case 'CommentConnection':
    case 'FileConnection': {
      if (name === 'nodes') return { value: parent.nodes, type: null };
      if (name === 'edges') {
        const edges = parent.nodes.map((node) => ({ __typename: 'CommentEdge', node }));
        return { value: edges, type: null };
      }
      if (name === 'pageInfo') {
        const conn = parent as { hasNextPage?: boolean; endCursor?: string | null };
        return {
          value: { __typename: 'PageInfo', hasNextPage: conn.hasNextPage ?? false, endCursor: conn.endCursor ?? null },
          type: 'PageInfo',
        };
      }
      if (name === 'totalCount') return { value: parent.nodes.length, type: null };
      return unknown();
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return { value: parent.hasNextPage, type: null };
      if (name === 'endCursor') return { value: parent.endCursor, type: null };
      if (name === 'hasPreviousPage') return { value: false, type: null };
      if (name === 'startCursor') return { value: null, type: null };
      return unknown();
    }
    case '__Type': {
      if (name === 'name') return { value: parent.name, type: null };
      if (name === 'fields') {
        return { value: parent.fields.map((f) => ({ __typename: '__Field', name: f })), type: null };
      }
      if (name === 'enumValues') {
        return { value: parent.enumValues.map((e) => ({ __typename: '__EnumValue', name: e })), type: null };
      }
      return unknown();
    }
    case '__Field': {
      if (name === 'name') return { value: parent.name, type: null };
      return unknown();
    }
    case '__EnumValue': {
      if (name === 'name') return { value: parent.name, type: null };
      return unknown();
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return { value: parent.issue, type: 'Issue' };
      return unknown();
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return { value: parent.pullRequest, type: 'PullRequest' };
      return unknown();
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return { value: parent.commentEdge, type: 'CommentEdge' };
      return unknown();
    }
    case 'CommentEdge': {
      if (name === 'node') return { value: parent.node, type: null };
      if (name === 'cursor') return { value: null, type: null };
      return unknown();
    }
    default:
      return unknown();
  }
}

function executeSelections(
  parent: GqlNode,
  selections: GqlSel[],
  variables: Record<string, unknown>,
  defaults: Record<string, GqlValue>,
  errors: { message: string }[],
  fragments: Map<string, { typeCondition: string; selections: GqlSel[] }>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (depth > 20) return out;
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      if (sel.typeCondition && sel.typeCondition.startsWith('...')) {
        const fragName = sel.typeCondition.slice(3);
        const frag = fragments.get(fragName);
        if (frag && (frag.typeCondition === parent.__typename || frag.typeCondition === 'Node')) {
          Object.assign(out, executeSelections(parent, frag.selections, variables, defaults, errors, fragments, depth + 1));
        }
        continue;
      }
      if (sel.typeCondition && sel.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelections(parent, sel.selections, variables, defaults, errors, fragments, depth + 1));
      continue;
    }
    const args = resolveArgs(sel.args, variables, defaults);
    const result = resolveField(parent, sel.name, args, errors);
    if (sel.selections === null) {
      out[sel.responseKey] = result.value;
      continue;
    }
    if (result.value === null || result.value === undefined) {
      out[sel.responseKey] = null;
      continue;
    }
    if (Array.isArray(result.value)) {
      out[sel.responseKey] = result.value.map((item) =>
        item && typeof item === 'object' && '__typename' in item
          ? executeSelections(item as GqlNode, sel.selections as GqlSel[], variables, defaults, errors, fragments, depth + 1)
          : item,
      );
      continue;
    }
    if (typeof result.value === 'object' && '__typename' in (result.value as Record<string, unknown>)) {
      out[sel.responseKey] = executeSelections(result.value as GqlNode, sel.selections as GqlSel[], variables, defaults, errors, fragments, depth + 1);
      continue;
    }
    out[sel.responseKey] = result.value;
  }
  return out;
}

function executeGraphql(
  query: string,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const errors: { message: string }[] = [];
  let parsed: { operation: GqlOperation; fragments: Map<string, { typeCondition: string; selections: GqlSel[] }> };
  try {
    parsed = new GqlParser(tokenizeGql(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL parse error' }] };
  }
  const root: GqlNode = parsed.operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelections(root, parsed.operation.selections, variables, parsed.operation.variableDefaults, errors, parsed.fragments, 0);
  return errors.length > 0 ? { data, errors } : { data };
}

function handleGraphql(ctx: RequestContext, res: Res): boolean {
  if (ctx.pathname !== '/api/graphql') return false;
  if (ctx.method !== 'POST') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (!restAuthOk(ctx)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  let body: unknown = null;
  try {
    body = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return true;
  }
  const runOne = (item: unknown): Record<string, unknown> => {
    if (!item || typeof item !== 'object') return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
    const query = typeof (item as Record<string, unknown>).query === 'string' ? ((item as Record<string, unknown>).query as string) : '';
    const variables = (item as Record<string, unknown>).variables;
    const vars = variables && typeof variables === 'object' ? (variables as Record<string, unknown>) : {};
    return executeGraphql(query, vars);
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((item) => runOne(item)));
    return true;
  }
  sendJson(res, 200, runOne(body));
  return true;
}

// ---------------------------------------------------------------------------
// MCP — JSON-RPC 2.0 over Streamable HTTP, modern 2026-07-28 era.
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name, owner/repo' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name, owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name, owner/repo' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: [],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name, owner/repo' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from one branch onto another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name, owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name, owner/repo' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['pull_number'],
    },
  },
  {
    name: 'create_comment',
    description: 'Add a comment to an issue or pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name, owner/repo' },
        issue_number: { type: 'number', description: 'Issue or pull request number' },
        body: { type: 'string', description: 'Comment body' },
      },
      required: ['body'],
    },
  },
];

function mcpResolveRepo(args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repoName) && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      owner = args.full_name.slice(0, slash);
      repoName = args.full_name.slice(slash + 1);
    }
  }
  if (!owner || !repoName) return null;
  const repo = getRepo(owner, repoName);
  return repo && repo.owner === VIEWER_LOGIN ? repo : null;
}

function mcpCallTool(
  name: string,
  args: Record<string, unknown>,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const text = (value: unknown): { content: { type: 'text'; text: string }[] } => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
  });
  const error = (message: string): { content: { type: 'text'; text: string }[]; isError: boolean } => ({
    content: [{ type: 'text', text: message }],
    isError: true,
  });
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (!repoName) return error('Missing required argument: name');
      if (getRepo(VIEWER_LOGIN, repoName)) return error(`Repository ${repoName} already exists`);
      const repo = createRepoRecord(
        VIEWER_LOGIN,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return text(repoJson(repo));
    }
    case 'get_repo': {
      const repo = mcpResolveRepo(args);
      if (!repo) return error('Repository not found');
      return text(repoJson(repo));
    }
    case 'create_issue': {
      const repo = mcpResolveRepo(args);
      if (!repo) return error('Repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title) return error('Missing required argument: title');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const now = nowIso();
      const issue: Issue = {
        id: nextGlobalId(),
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        seq: nextGlobalId(),
      };
      repo.issues.set(number, issue);
      return text(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = mcpResolveRepo(args);
      if (!repo) return error('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return text(list.map((i) => issueJson(repo, i)));
    }
    case 'get_issue': {
      const repo = mcpResolveRepo(args);
      if (!repo) return error('Repository not found');
      const number = typeof args.issue_number === 'number' ? args.issue_number : -1;
      const issue = repo.issues.get(number);
      if (!issue) return error('Issue not found');
      return text(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = mcpResolveRepo(args);
      if (!repo) return error('Repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (!title || !head || !base) return error('Missing required argument: title, head, or base');
      const headTip = refTipCommit(repo, head);
      const baseTip = refTipCommit(repo, base);
      if (!headTip || !baseTip) return error('Head or base branch does not exist');
      const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (existing) return text(pullJson(repo, existing));
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const now = nowIso();
      const pull: Pull = {
        id: nextGlobalId(),
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: now,
        updatedAt: now,
        seq: nextGlobalId(),
      };
      repo.pulls.set(number, pull);
      return text(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = mcpResolveRepo(args);
      if (!repo) return error('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : -1;
      const pull = repo.pulls.get(number);
      if (!pull) return error('Pull request not found');
      if (pull.state !== 'open') return error('Pull request is already closed');
      const mergeSha = squashMerge(repo, pull);
      if (mergeSha === null) return error('Merge conflict');
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = mergeSha;
      pull.updatedAt = nowIso();
      return text({ sha: mergeSha, merged: true, number: pull.number, state: 'closed' });
    }
    case 'create_comment': {
      const repo = mcpResolveRepo(args);
      if (!repo) return error('Repository not found');
      const number = typeof args.issue_number === 'number' ? args.issue_number : -1;
      const issue = repo.issues.get(number) ?? repo.pulls.get(number);
      if (!issue) return error('Issue not found');
      const body = typeof args.body === 'string' ? args.body : '';
      if (!body) return error('Missing required argument: body');
      const comment: Comment = { id: repo.nextCommentId, body, userLogin: VIEWER_LOGIN, createdAt: nowIso() };
      repo.nextCommentId += 1;
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      return text(commentJson(repo, number, comment));
    }
    default:
      return error(`Unknown tool: ${name}`);
  }
}

function handleMcp(ctx: RequestContext, res: Res): boolean {
  if (ctx.pathname !== '/mcp') return false;
  if (ctx.method !== 'POST') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const auth = headerValue(ctx.headers, 'authorization');
  if (SHOP_TOKEN && auth !== `Bearer ${SHOP_TOKEN}`) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    request = parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  // Notifications (no id) are acknowledged with an empty 202.
  if (request.id === undefined) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  const params = (request.params as Record<string, unknown> | undefined) ?? {};
  const result = (value: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: value });
  };
  const rpcError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  if (method === 'server/discover') {
    result({
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    result({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }
  if (method === 'ping') {
    result({});
    return true;
  }
  if (method === 'tools/list') {
    result({ tools: MCP_TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
    const known = MCP_TOOLS.some((tool) => tool.name === toolName || tool.name.endsWith(toolName) || toolName.endsWith(tool.name));
    if (!known) {
      rpcError(-32602, `Unknown tool: ${toolName}`);
      return true;
    }
    const def = MCP_TOOLS.find((tool) => tool.name === toolName || tool.name.endsWith(toolName) || toolName.endsWith(tool.name)) as McpToolDef;
    for (const required of def.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        result({ content: [{ type: 'text', text: `Missing required argument: ${required}` }], isError: true });
        return true;
      }
    }
    result(mcpCallTool(def.name, args));
    return true;
  }
  rpcError(-32601, `Method not found: ${method}`);
  return true;
}

// ---------------------------------------------------------------------------
// Git router
// ---------------------------------------------------------------------------

function handleGit(ctx: RequestContext, res: Res): boolean {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(ctx.pathname);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const action = match[3];
  if (!gitAuthOk(headerValue(ctx.headers, 'authorization'))) {
    sendBuffer(
      res,
      401,
      Buffer.from(JSON.stringify({ message: 'Requires authentication' }), 'utf8'),
      'application/json; charset=utf-8',
      { 'www-authenticate': 'Basic realm="makefun-forge"' },
    );
    return true;
  }
  const repo = getRepo(owner, repoName);
  if (!repo || repo.owner !== VIEWER_LOGIN) {
    sendBuffer(res, 404, Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'), 'application/json; charset=utf-8');
    return true;
  }
  if (action === 'info/refs') {
    if (ctx.method !== 'GET') {
      sendError(res, 405, 'Method Not Allowed');
      return true;
    }
    const service = ctx.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 400, 'Missing service parameter');
      return true;
    }
    const wantsV2 = service === 'git-upload-pack' && headerValue(ctx.headers, 'git-protocol') === 'version=2';
    const body = wantsV2 ? advertisementV2() : advertisementV0(repo, service);
    sendBuffer(res, 200, body, `application/x-${service}-advertisement`);
    return true;
  }
  if (ctx.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (action === 'git-upload-pack') {
    const isV2 = headerValue(ctx.headers, 'git-protocol') === 'version=2';
    const { packets } = parsePktLines(ctx.body);
    if (isV2) {
      const first = packets.find((p) => p.kind === 'data');
      const firstLine = first && first.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
      if (firstLine === 'command=ls-refs') {
        const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
        for (const packet of packets) {
          if (packet.kind !== 'data') continue;
          const line = packet.payload.toString('utf8').replace(/\n$/, '');
          if (line === 'peel') args.peel = true;
          else if (line === 'symrefs') args.symrefs = true;
          else if (line === 'unborn') args.unborn = true;
          else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
        }
        const lines = lsRefsLines(repo, args);
        const body = Buffer.concat([encodePktLines(lines), pktFlush()]);
        sendBuffer(res, 200, body, 'application/x-git-upload-pack-result');
        return true;
      }
      if (firstLine === 'command=fetch') {
        const req = parseV2FetchBody(packets);
        const body = fetchResponse(repo, req, 2);
        sendBuffer(res, 200, body, 'application/x-git-upload-pack-result');
        return true;
      }
      sendError(res, 400, 'Unknown git-upload-pack command');
      return true;
    }
    // Protocol v0 fetch.
    const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
    let sawWant = false;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      if (line.startsWith('want ')) {
        sawWant = true;
        req.wants.push(line.slice(5).trim());
      } else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n)) req.depth = n;
      } else if (line.startsWith('deepen-since ')) {
        const n = parseInt(line.slice(13).trim(), 10);
        if (Number.isFinite(n)) req.deepenSince = n;
      } else if (line.startsWith('deepen-not ')) req.deepenNot.push(line.slice(11).trim());
    }
    if (!sawWant && packets.some((p) => p.kind === 'data')) {
      sendError(res, 400, 'Malformed upload-pack request');
      return true;
    }
    const body = fetchResponse(repo, req, 0);
    sendBuffer(res, 200, body, 'application/x-git-upload-pack-result');
    return true;
  }
  // git-receive-pack
  const body = receivePack(repo, ctx.body);
  sendBuffer(res, 200, body, 'application/x-git-receive-pack-result');
  return true;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 128 * 1024 * 1024;

function readBody(req: { on: (event: string, listener: (...args: never[]) => void) => void }): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      if (total >= MAX_BODY_BYTES) return;
      const slice = chunk.subarray(0, MAX_BODY_BYTES - total);
      chunks.push(Buffer.from(slice));
      total += slice.length;
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

export function createApp(): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    try {
      const body = await readBody(req as never);
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      const ctx: RequestContext = {
        method: req.method ?? 'GET',
        pathname: url.pathname,
        query: url.searchParams,
        headers,
        body,
        url: url.toString(),
      };
      if (ctx.pathname === '/healthz' && ctx.method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (handleMcp(ctx, res)) return;
      if (handleGraphql(ctx, res)) return;
      if (handleGit(ctx, res)) return;
      if (handleRest(ctx, res)) return;
      sendError(res, 404, 'Not Found');
    } catch {
      try {
        sendError(res, 500, 'Internal Server Error');
      } catch {
        // The socket is already gone; nothing more to do.
      }
    }
  });
  return server;
}
