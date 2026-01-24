/**
 * URL-hash sharing: '#m=' + base64url(deflate-raw(JSON)) via CompressionStream,
 * '#mu=' + base64url(JSON) fallback. Schema v1 = EditorModel. M7.
 * Property gate G11: decode(encode(m)) deep-equals m.
 */
import { buildMesh } from '../fem/mesh';
import type { EditorModel, MemberSpec, SectionSpec, StorySpec } from '../fem/types';

/** Encode a validated model as a URL fragment, compressing when the platform provides CompressionStream. */
export async function encodeModel(model: EditorModel): Promise<string> {
  const valid = validateModel(model);
  const bytes = new TextEncoder().encode(JSON.stringify(valid));
  if (typeof CompressionStream === 'undefined') return `#mu=${base64urlEncode(bytes)}`;
  try {
    const compressed = await streamBytes(blobFromBytes(bytes).stream().pipeThrough(new CompressionStream('deflate-raw')));
    return `#m=${base64urlEncode(compressed)}`;
  } catch {
    // The uncompressed form is deliberately a valid, portable fallback.
    return `#mu=${base64urlEncode(bytes)}`;
  }
}

/** Deterministic `#mu=` share fragment for curated gallery JSON. */
export function encodeModelUncompressed(model: EditorModel): string {
  const valid = validateModel(model);
  return `#mu=${base64urlEncode(new TextEncoder().encode(JSON.stringify(valid)))}`;
}

/** Decode a #m/#mu fragment and validate its exact v1 model shape before it reaches editor state. */
export async function decodeModel(hash: string): Promise<EditorModel> {
  const fragment = hash.startsWith('#') ? hash : new URL(hash, 'https://limit-state.local').hash;
  const match = /^#(m|mu)=([A-Za-z0-9_-]+)$/.exec(fragment);
  if (!match) throw new Error('Share URL must contain a #m= or #mu= model fragment.');
  const encoded = base64urlDecode(match[2]!);
  let bytes = encoded;
  if (match[1] === 'm') {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress #m share URLs.');
    try {
      bytes = await streamBytes(blobFromBytes(encoded).stream().pipeThrough(new DecompressionStream('deflate-raw')));
    } catch {
      throw new Error('Shared model compression data is invalid.');
    }
  }
  try {
    return validateModel(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('Shared model JSON is invalid.');
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
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('Shared model is not valid base64url data.');
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function validateModel(value: unknown): EditorModel {
  if (!isRecord(value) || value.v !== 1 || typeof value.name !== 'string' || !finiteInteger(value.seed)) {
    throw new Error('Shared model does not match Limit State schema v1.');
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.members) || !Array.isArray(value.supports) || !Array.isArray(value.deck)) {
    throw new Error('Shared model has malformed collections.');
  }
  if (!isRecord(value.loads) || typeof value.loads.gravity !== 'boolean' || !Array.isArray(value.loads.points)) {
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
  if (!isRecord(value) || !finiteInteger(value.id) || !finite(value.x) || !finite(value.y)) throw new Error('Shared model has an invalid node.');
  return { id: value.id, x: value.x, y: value.y };
}

function parseMember(value: unknown): MemberSpec {
  if (!isRecord(value) || !finiteInteger(value.id) || !finiteInteger(value.a) || !finiteInteger(value.b) || !validMaterial(value.material) || typeof value.releaseA !== 'boolean' || typeof value.releaseB !== 'boolean') {
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
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('Shared model has an invalid section.');
  switch (value.kind) {
    case 'rect':
      if (!finitePositive(value.b) || !finitePositive(value.h)) break;
      return { kind: 'rect', b: value.b, h: value.h };
    case 'box':
      if (!finitePositive(value.b) || !finitePositive(value.h) || !finitePositive(value.t)) break;
      return { kind: 'box', b: value.b, h: value.h, t: value.t };
    case 'ibeam':
      if (!finitePositive(value.b) || !finitePositive(value.h) || !finitePositive(value.tf) || !finitePositive(value.tw)) break;
      return { kind: 'ibeam', b: value.b, h: value.h, tf: value.tf, tw: value.tw };
    case 'tube':
      if (!finitePositive(value.d) || !finitePositive(value.t)) break;
      return { kind: 'tube', d: value.d, t: value.t };
  }
  throw new Error('Shared model has invalid section dimensions.');
}

function parseSupport(value: unknown): EditorModel['supports'][number] {
  if (!isRecord(value) || !finiteInteger(value.node) || (value.kind !== 'pin' && value.kind !== 'roller' && value.kind !== 'fixed')) {
    throw new Error('Shared model has an invalid support.');
  }
  return { node: value.node, kind: value.kind };
}

function parsePoint(value: unknown): EditorModel['loads']['points'][number] {
  if (!isRecord(value) || !finiteInteger(value.node) || !finite(value.fx) || !finite(value.fy)) throw new Error('Shared model has an invalid point load.');
  return { node: value.node, fx: value.fx, fy: value.fy };
}

function parseStory(value: unknown): StorySpec {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('Shared model has an invalid story.');
  if (value.kind === 'ramp') return { kind: 'ramp' };
  if (value.kind === 'pushover') return { kind: 'pushover' };
  if (value.kind === 'traffic' && finitePositive(value.weightkN) && finitePositive(value.speed)) {
    const movingMass = value.movingMass === undefined ? false : value.movingMass === true;
    if (value.movingMass !== undefined && typeof value.movingMass !== 'boolean') {
      throw new Error('Shared model has invalid story settings.');
    }
    return { kind: 'traffic', weightkN: value.weightkN, speed: value.speed, movingMass };
  }
  if (value.kind === 'wind' && (value.pattern === 'steady' || value.pattern === 'sine' || value.pattern === 'gusts') && finitePositive(value.amplitudekNm) && finitePositive(value.freqHz) && finitePositive(value.zeta)) {
    return { kind: 'wind', pattern: value.pattern, amplitudekNm: value.amplitudekNm, freqHz: value.freqHz, zeta: value.zeta };
  }
  if (
    value.kind === 'earthquake'
    && (value.record === 'pulse' || value.record === 'chirp' || value.record === 'elcentro-scaled')
    && finitePositive(value.scale)
    && finitePositive(value.zeta)
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
  return value === 'steel-s355' || value === 'alu-6061' || value === 'timber' || value === 'spaghetti';
}
