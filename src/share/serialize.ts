/**
 * URL-hash sharing: '#m=' + base64url(deflate-raw(JSON)) via CompressionStream,
 * '#mu=' + base64url(JSON) fallback. Schema v1 = EditorModel; v2 = EditorModel3d
 * with automatic v1→v2 migration. docs/FEM-SPEC.md §5 / §14 Phase 3.
 * Property gate G11: decode(encode(m)) deep-equals m (v1).
 * Gate G28: golden v1 URLs decode identically; migrateV1toV2 is deterministic.
 */
import { buildMesh } from '../fem/mesh';
import {
  buildMesh3d,
  NO_RELEASES,
  type EditorModel3d,
  type EndReleases3d,
  type SupportKind3d,
} from '../fem/space';
import type { EditorModel, MemberSpec, SectionSpec, StorySpec } from '../fem/types';

/** Encode a validated model as a URL fragment, compressing when the platform provides CompressionStream. docs/FEM-SPEC.md §5. */
export async function encodeModel(model: EditorModel): Promise<string> {
  const valid = validateModel(model);
  const bytes = new TextEncoder().encode(JSON.stringify(valid));
  if (typeof CompressionStream === 'undefined') return `#mu=${base64urlEncode(bytes)}`;
  try {
    const compressed = await streamBytes(
      blobFromBytes(bytes).stream().pipeThrough(new CompressionStream('deflate-raw')),
    );
    return `#m=${base64urlEncode(compressed)}`;
  } catch {
    // The uncompressed form is deliberately a valid, portable fallback.
    return `#mu=${base64urlEncode(bytes)}`;
  }
}

/** Deterministic `#mu=` share fragment for curated gallery JSON. docs/FEM-SPEC.md §14 2G. */
export function encodeModelUncompressed(model: EditorModel): string {
  const valid = validateModel(model);
  return `#mu=${base64urlEncode(new TextEncoder().encode(JSON.stringify(valid)))}`;
}

/** Decode a #m/#mu fragment and validate its exact v1 model shape before it reaches editor state. docs/FEM-SPEC.md §5. */
export async function decodeModel(hash: string): Promise<EditorModel> {
  const fragment = hash.startsWith('#') ? hash : new URL(hash, 'https://limit-state.local').hash;
  const match = /^#(m|mu)=([A-Za-z0-9_-]+)$/.exec(fragment);
  if (!match) throw new Error('Share URL must contain a #m= or #mu= model fragment.');
  const encoded = base64urlDecode(match[2]!);
  let bytes = encoded;
  if (match[1] === 'm') {
    if (typeof DecompressionStream === 'undefined')
      throw new Error('This browser cannot decompress #m share URLs.');
    try {
      bytes = await streamBytes(
        blobFromBytes(encoded).stream().pipeThrough(new DecompressionStream('deflate-raw')),
      );
    } catch (error) {
      throw new Error('Shared model compression data is invalid.', { cause: error });
    }
  }
  try {
    return validateModel(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('Shared model JSON is invalid.', { cause: error });
  }
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function blobFromBytes(bytes: Uint8Array): Blob {
  const copied = new Uint8Array(bytes.length);
  copied.set(bytes);
  return new Blob([copied.buffer]);
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(value: string): Uint8Array {
  const base64 =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('Shared model is not valid base64url data.');
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function validateModel(value: unknown): EditorModel {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.name !== 'string' ||
    !finiteInteger(value.seed)
  ) {
    throw new Error('Shared model does not match Limit State schema v1.');
  }
  if (
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.members) ||
    !Array.isArray(value.supports) ||
    !Array.isArray(value.deck)
  ) {
    throw new Error('Shared model has malformed collections.');
  }
  if (
    !isRecord(value.loads) ||
    typeof value.loads.gravity !== 'boolean' ||
    !Array.isArray(value.loads.points)
  ) {
    throw new Error('Shared model has malformed loads.');
  }
  const model: EditorModel = {
    v: 1,
    name: value.name,
    seed: value.seed,
    nodes: value.nodes.map(parseNode),
    members: value.members.map(parseMember),
    supports: value.supports.map(parseSupport),
    loads: { gravity: value.loads.gravity, points: value.loads.points.map(parsePoint) },
    deck: value.deck.map((id) => {
      if (!finiteInteger(id)) throw new Error('Deck ids must be finite integers.');
      return id;
    }),
    story: parseStory(value.story),
  };
  // Mesh validation owns cross-references, duplicate ids, finite geometry, and deck continuity.
  buildMesh(model);
  return model;
}

function parseNode(value: unknown): EditorModel['nodes'][number] {
  if (!isRecord(value) || !finiteInteger(value.id) || !finite(value.x) || !finite(value.y))
    throw new Error('Shared model has an invalid node.');
  return { id: value.id, x: value.x, y: value.y };
}

function parseMember(value: unknown): MemberSpec {
  if (
    !isRecord(value) ||
    !finiteInteger(value.id) ||
    !finiteInteger(value.a) ||
    !finiteInteger(value.b) ||
    !validMaterial(value.material) ||
    typeof value.releaseA !== 'boolean' ||
    typeof value.releaseB !== 'boolean'
  ) {
    throw new Error('Shared model has an invalid member.');
  }
  const cableOnly = value.cableOnly === undefined ? false : value.cableOnly === true;
  if (value.cableOnly !== undefined && typeof value.cableOnly !== 'boolean') {
    throw new Error('Shared model has an invalid member.');
  }
  const member: MemberSpec = {
    id: value.id,
    a: value.a,
    b: value.b,
    material: value.material,
    section: parseSection(value.section),
    releaseA: cableOnly ? true : value.releaseA,
    releaseB: cableOnly ? true : value.releaseB,
    cableOnly,
  };
  return member;
}

function parseSection(value: unknown): SectionSpec {
  if (!isRecord(value) || typeof value.kind !== 'string')
    throw new Error('Shared model has an invalid section.');
  switch (value.kind) {
    case 'rect':
      if (!finitePositive(value.b) || !finitePositive(value.h)) break;
      return { kind: 'rect', b: value.b, h: value.h };
    case 'box':
      if (!finitePositive(value.b) || !finitePositive(value.h) || !finitePositive(value.t)) break;
      return { kind: 'box', b: value.b, h: value.h, t: value.t };
    case 'ibeam':
      if (
        !finitePositive(value.b) ||
        !finitePositive(value.h) ||
        !finitePositive(value.tf) ||
        !finitePositive(value.tw)
      )
        break;
      return { kind: 'ibeam', b: value.b, h: value.h, tf: value.tf, tw: value.tw };
    case 'tube':
      if (!finitePositive(value.d) || !finitePositive(value.t)) break;
      return { kind: 'tube', d: value.d, t: value.t };
  }
  throw new Error('Shared model has invalid section dimensions.');
}

function parseSupport(value: unknown): EditorModel['supports'][number] {
  if (
    !isRecord(value) ||
    !finiteInteger(value.node) ||
    (value.kind !== 'pin' && value.kind !== 'roller' && value.kind !== 'fixed')
  ) {
    throw new Error('Shared model has an invalid support.');
  }
  return { node: value.node, kind: value.kind };
}

function parsePoint(value: unknown): EditorModel['loads']['points'][number] {
  if (!isRecord(value) || !finiteInteger(value.node) || !finite(value.fx) || !finite(value.fy))
    throw new Error('Shared model has an invalid point load.');
  return { node: value.node, fx: value.fx, fy: value.fy };
}

function parseStory(value: unknown): StorySpec {
  if (!isRecord(value) || typeof value.kind !== 'string')
    throw new Error('Shared model has an invalid story.');
  if (value.kind === 'ramp') return { kind: 'ramp' };
  if (value.kind === 'pushover') return { kind: 'pushover' };
  if (value.kind === 'traffic' && finitePositive(value.weightkN) && finitePositive(value.speed)) {
    const movingMass = value.movingMass === undefined ? false : value.movingMass === true;
    if (value.movingMass !== undefined && typeof value.movingMass !== 'boolean') {
      throw new Error('Shared model has invalid story settings.');
    }
    return { kind: 'traffic', weightkN: value.weightkN, speed: value.speed, movingMass };
  }
  if (
    value.kind === 'wind' &&
    (value.pattern === 'steady' || value.pattern === 'sine' || value.pattern === 'gusts') &&
    finitePositive(value.amplitudekNm) &&
    finitePositive(value.freqHz) &&
    finitePositive(value.zeta)
  ) {
    return {
      kind: 'wind',
      pattern: value.pattern,
      amplitudekNm: value.amplitudekNm,
      freqHz: value.freqHz,
      zeta: value.zeta,
    };
  }
  if (
    value.kind === 'earthquake' &&
    (value.record === 'pulse' || value.record === 'chirp' || value.record === 'elcentro-scaled') &&
    finitePositive(value.scale) &&
    finitePositive(value.zeta)
  ) {
    return { kind: 'earthquake', record: value.record, scale: value.scale, zeta: value.zeta };
  }
  throw new Error('Shared model has invalid story settings.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finitePositive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function finiteInteger(value: unknown): value is number {
  return finite(value) && Number.isInteger(value);
}

function validMaterial(value: unknown): value is MemberSpec['material'] {
  return (
    value === 'steel-s355' || value === 'alu-6061' || value === 'timber' || value === 'spaghetti'
  );
}

/**
 * Lift a planar v1 model into schema v2: z = 0, roll = 0, moment releases → θz.
 * Old share URLs still decode as v1 via decodeModel; this is the explicit upgrade path.
 * docs/FEM-SPEC.md §14 Phase 3 Editor / gate G28 / closeout 3U.
 */
export function migrateV1toV2(model: EditorModel): EditorModel3d {
  const valid = validateModel(model);
  return {
    v: 2,
    name: valid.name,
    seed: valid.seed,
    nodes: valid.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, z: 0 })),
    members: valid.members.map((member) => ({
      id: member.id,
      a: member.a,
      b: member.b,
      material: member.material,
      section: member.section,
      releaseA: boolReleaseTo3d(member.releaseA || member.cableOnly),
      releaseB: boolReleaseTo3d(member.releaseB || member.cableOnly),
      roll: 0,
      cableOnly: member.cableOnly,
    })),
    supports: valid.supports.map((support) => ({
      node: support.node,
      kind: migrateSupportKind(support.kind),
    })),
    loads: {
      gravity: valid.loads.gravity,
      points: valid.loads.points.map((point) => ({
        node: point.node,
        fx: point.fx,
        fy: point.fy,
        fz: 0,
      })),
    },
    deck: [...valid.deck],
    story: migrateStoryTo3d(valid.story),
  };
}

/** Map a v1 story into the 3D story union (wind gains directionDeg = 0). docs/FEM-SPEC.md §14 3U. */
function migrateStoryTo3d(story: StorySpec): NonNullable<EditorModel3d['story']> {
  if (story.kind === 'traffic') {
    return {
      kind: 'traffic',
      weightkN: story.weightkN,
      speed: story.speed,
      movingMass: story.movingMass,
    };
  }
  if (story.kind === 'wind') {
    return {
      kind: 'wind',
      pattern: story.pattern,
      amplitudekNm: story.amplitudekNm,
      freqHz: story.freqHz,
      zeta: story.zeta,
      directionDeg: 0,
    };
  }
  if (story.kind === 'earthquake') {
    return { kind: 'earthquake', record: story.record, scale: story.scale, zeta: story.zeta };
  }
  if (story.kind === 'pushover') return { kind: 'pushover' };
  return { kind: 'ramp' };
}

function boolReleaseTo3d(released: boolean): EndReleases3d {
  // Moment release → θy+θz; keep torsion for nonsingular condensation. docs/FEM-SPEC.md §14 3U.
  return released ? { tx: false, ty: true, tz: true } : { ...NO_RELEASES };
}

function migrateSupportKind(kind: 'pin' | 'roller' | 'fixed'): SupportKind3d {
  if (kind === 'fixed') return 'fixed';
  if (kind === 'roller') return 'rollerX'; // 2D roller intent: free horizontal
  return 'pin';
}

/** Deterministic `#mu=` share fragment for curated 3D gallery entries. docs/FEM-SPEC.md §14 4J. */
export function encodeModelUncompressed3d(model: EditorModel3d): string {
  const valid = validateModel3d(model);
  return `#mu=${base64urlEncode(new TextEncoder().encode(JSON.stringify(valid)))}`;
}

/** Encode a validated v2 space-frame model as a URL fragment. docs/FEM-SPEC.md §14 Phase 3. */
export async function encodeModel3d(model: EditorModel3d): Promise<string> {
  const valid = validateModel3d(model);
  const bytes = new TextEncoder().encode(JSON.stringify(valid));
  if (typeof CompressionStream === 'undefined') return `#mu=${base64urlEncode(bytes)}`;
  try {
    const compressed = await streamBytes(
      blobFromBytes(bytes).stream().pipeThrough(new CompressionStream('deflate-raw')),
    );
    return `#m=${base64urlEncode(compressed)}`;
  } catch {
    return `#mu=${base64urlEncode(bytes)}`;
  }
}

/** Decode a #m/#mu fragment as schema v2 (rejects v1 — use decodeModel + migrateV1toV2). docs/FEM-SPEC.md §14. */
export async function decodeModel3d(hash: string): Promise<EditorModel3d> {
  const fragment = hash.startsWith('#') ? hash : new URL(hash, 'https://limit-state.local').hash;
  const match = /^#(m|mu)=([A-Za-z0-9_-]+)$/.exec(fragment);
  if (!match) throw new Error('Share URL must contain a #m= or #mu= model fragment.');
  const encoded = base64urlDecode(match[2]!);
  let bytes = encoded;
  if (match[1] === 'm') {
    if (typeof DecompressionStream === 'undefined')
      throw new Error('This browser cannot decompress #m share URLs.');
    try {
      bytes = await streamBytes(
        blobFromBytes(encoded).stream().pipeThrough(new DecompressionStream('deflate-raw')),
      );
    } catch (error) {
      throw new Error('Shared model compression data is invalid.', { cause: error });
    }
  }
  try {
    return validateModel3d(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('Shared model JSON is invalid.', { cause: error });
  }
}

/**
 * Peek schema version from a share fragment without full validate.
 * docs/FEM-SPEC.md §14 3U — boot loads v2 into 3D, v1 into 2D.
 */
export async function peekShareSchemaVersion(hash: string): Promise<1 | 2> {
  const fragment = hash.startsWith('#') ? hash : new URL(hash, 'https://limit-state.local').hash;
  const match = /^#(m|mu)=([A-Za-z0-9_-]+)$/.exec(fragment);
  if (!match) throw new Error('Share URL must contain a #m= or #mu= model fragment.');
  const encoded = base64urlDecode(match[2]!);
  let bytes = encoded;
  if (match[1] === 'm') {
    if (typeof DecompressionStream === 'undefined')
      throw new Error('This browser cannot decompress #m share URLs.');
    try {
      bytes = await streamBytes(
        blobFromBytes(encoded).stream().pipeThrough(new DecompressionStream('deflate-raw')),
      );
    } catch {
      throw new Error('Shared model compression data is invalid.');
    }
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(parsed) || (parsed.v !== 1 && parsed.v !== 2)) {
    throw new Error('Shared model does not declare schema v1 or v2.');
  }
  return parsed.v;
}

function validateModel3d(value: unknown): EditorModel3d {
  if (
    !isRecord(value) ||
    value.v !== 2 ||
    typeof value.name !== 'string' ||
    !finiteInteger(value.seed)
  ) {
    throw new Error('Shared model does not match Limit State schema v2.');
  }
  if (
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.members) ||
    !Array.isArray(value.supports)
  ) {
    throw new Error('Shared model has malformed collections.');
  }
  if (
    !isRecord(value.loads) ||
    typeof value.loads.gravity !== 'boolean' ||
    !Array.isArray(value.loads.points)
  ) {
    throw new Error('Shared model has malformed loads.');
  }
  const deck =
    value.deck === undefined
      ? undefined
      : Array.isArray(value.deck)
        ? value.deck.map((id) => {
            if (!finiteInteger(id)) throw new Error('Deck ids must be finite integers.');
            return id;
          })
        : (() => {
            throw new Error('Shared model has malformed deck.');
          })();
  const model: EditorModel3d = {
    v: 2,
    name: value.name,
    seed: value.seed,
    nodes: value.nodes.map(parseNode3d),
    members: value.members.map(parseMember3d),
    supports: value.supports.map(parseSupport3d),
    loads: { gravity: value.loads.gravity, points: value.loads.points.map(parsePoint3d) },
    ...(deck !== undefined ? { deck } : {}),
    story: value.story === undefined ? undefined : parseStory3d(value.story),
  };
  buildMesh3d(model);
  return model;
}

function parseNode3d(value: unknown): EditorModel3d['nodes'][number] {
  if (
    !isRecord(value) ||
    !finiteInteger(value.id) ||
    !finite(value.x) ||
    !finite(value.y) ||
    !finite(value.z)
  ) {
    throw new Error('Shared model has an invalid 3D node.');
  }
  return { id: value.id, x: value.x, y: value.y, z: value.z };
}

function parseMember3d(value: unknown): EditorModel3d['members'][number] {
  if (
    !isRecord(value) ||
    !finiteInteger(value.id) ||
    !finiteInteger(value.a) ||
    !finiteInteger(value.b) ||
    !validMaterial(value.material) ||
    !finite(value.roll)
  ) {
    throw new Error('Shared model has an invalid 3D member.');
  }
  const cableOnly = value.cableOnly === undefined ? false : value.cableOnly === true;
  if (value.cableOnly !== undefined && typeof value.cableOnly !== 'boolean') {
    throw new Error('Shared model has an invalid 3D member.');
  }
  const releaseA = cableOnly ? { tx: false, ty: true, tz: true } : parseReleases(value.releaseA);
  const releaseB = cableOnly ? { tx: false, ty: true, tz: true } : parseReleases(value.releaseB);
  return {
    id: value.id,
    a: value.a,
    b: value.b,
    material: value.material,
    section: parseSection(value.section),
    releaseA,
    releaseB,
    roll: value.roll,
    cableOnly,
  };
}

function parseReleases(value: unknown): EndReleases3d {
  if (
    !isRecord(value) ||
    typeof value.tx !== 'boolean' ||
    typeof value.ty !== 'boolean' ||
    typeof value.tz !== 'boolean'
  ) {
    throw new Error('Shared model has invalid end releases.');
  }
  return { tx: value.tx, ty: value.ty, tz: value.tz };
}

function parseSupport3d(value: unknown): EditorModel3d['supports'][number] {
  const kinds: SupportKind3d[] = ['pin', 'rollerX', 'rollerY', 'rollerZ', 'fixed'];
  if (
    !isRecord(value) ||
    !finiteInteger(value.node) ||
    typeof value.kind !== 'string' ||
    !kinds.includes(value.kind as SupportKind3d)
  ) {
    throw new Error('Shared model has an invalid 3D support.');
  }
  return { node: value.node, kind: value.kind as SupportKind3d };
}

function parsePoint3d(value: unknown): EditorModel3d['loads']['points'][number] {
  if (
    !isRecord(value) ||
    !finiteInteger(value.node) ||
    !finite(value.fx) ||
    !finite(value.fy) ||
    !finite(value.fz)
  ) {
    throw new Error('Shared model has an invalid 3D point load.');
  }
  const point: EditorModel3d['loads']['points'][number] = {
    node: value.node,
    fx: value.fx,
    fy: value.fy,
    fz: value.fz,
  };
  if (value.mx !== undefined) {
    if (!finite(value.mx)) throw new Error('Shared model has an invalid 3D point load.');
    point.mx = value.mx;
  }
  if (value.my !== undefined) {
    if (!finite(value.my)) throw new Error('Shared model has an invalid 3D point load.');
    point.my = value.my;
  }
  if (value.mz !== undefined) {
    if (!finite(value.mz)) throw new Error('Shared model has an invalid 3D point load.');
    point.mz = value.mz;
  }
  return point;
}

function parseStory3d(value: unknown): NonNullable<EditorModel3d['story']> {
  if (!isRecord(value) || typeof value.kind !== 'string')
    throw new Error('Shared model has an invalid 3D story.');
  if (value.kind === 'ramp') return { kind: 'ramp' };
  if (value.kind === 'pushover') return { kind: 'pushover' };
  if (value.kind === 'traffic' && finitePositive(value.weightkN) && finitePositive(value.speed)) {
    const movingMass = value.movingMass === undefined ? false : value.movingMass === true;
    if (value.movingMass !== undefined && typeof value.movingMass !== 'boolean') {
      throw new Error('Shared model has invalid 3D story settings.');
    }
    return { kind: 'traffic', weightkN: value.weightkN, speed: value.speed, movingMass };
  }
  if (
    value.kind === 'wind' &&
    (value.pattern === 'steady' || value.pattern === 'sine' || value.pattern === 'gusts') &&
    finitePositive(value.amplitudekNm) &&
    finitePositive(value.freqHz) &&
    finitePositive(value.zeta) &&
    finite(value.directionDeg)
  ) {
    return {
      kind: 'wind',
      pattern: value.pattern,
      amplitudekNm: value.amplitudekNm,
      freqHz: value.freqHz,
      zeta: value.zeta,
      directionDeg: value.directionDeg,
    };
  }
  if (
    value.kind === 'earthquake' &&
    (value.record === 'pulse' || value.record === 'chirp' || value.record === 'elcentro-scaled') &&
    finitePositive(value.scale) &&
    finitePositive(value.zeta)
  ) {
    return { kind: 'earthquake', record: value.record, scale: value.scale, zeta: value.zeta };
  }
  throw new Error('Shared model has invalid 3D story settings.');
}
