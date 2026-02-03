/**
 * Extrude / replicate — pure EditorModel3d transforms.
 * 2D truss → spatial truss in two operations.
 *
 * Extrude: copy selected (or all) nodes along an offset, copy in-plane members
 * onto each new layer, and add strut members connecting corresponding nodes.
 * Replicate: same copy without the connecting struts (array / bay repeat).
 */
import type { EditorModel3d, MemberSpec3d, NodeSpec3d } from '../fem/space';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ExtrudeOptions {
  offset: Vec3;
  /** Number of copies along offset (default 1). */
  count?: number;
  /**
   * Node IDs to include. Default: all nodes. Members are included when both
   * endpoints are in the set. Supports/loads on those nodes are not copied.
   */
  nodeIds?: number[];
  /** Copy in-plane members onto each new layer (default true). */
  copyMembers?: boolean;
  /** Add members linking each source node to its image (default true). */
  connectLayers?: boolean;
  /** Optional ID allocator; defaults to max(existing)+1 sequential. */
  allocId?: () => number;
}

export interface ExtrudeResult {
  model: EditorModel3d;
  /** Source node id → image node id for the last layer created. */
  nodeMap: Map<number, number>;
  addedNodes: number;
  addedMembers: number;
}

function makeAllocator(model: EditorModel3d, override?: () => number): () => number {
  if (override) return override;
  let next = Math.max(0, ...model.nodes.map((n) => n.id), ...model.members.map((m) => m.id)) + 1;
  return () => next++;
}

function offsetLen2(o: Vec3): number {
  return o.x * o.x + o.y * o.y + o.z * o.z;
}

/**
 * Extrude (or replicate when `connectLayers: false`) a planar sketch into space.
 */
export function extrudeModel3d(model: EditorModel3d, options: ExtrudeOptions): ExtrudeResult {
  const count = Math.max(1, Math.floor(options.count ?? 1));
  const copyMembers = options.copyMembers ?? true;
  const connectLayers = options.connectLayers ?? true;
  const offset = options.offset;

  if (offsetLen2(offset) < 1e-18) {
    return { model, nodeMap: new Map(), addedNodes: 0, addedMembers: 0 };
  }

  const sourceIds = new Set(options.nodeIds ?? model.nodes.map((n) => n.id));
  if (sourceIds.size === 0) {
    return { model, nodeMap: new Map(), addedNodes: 0, addedMembers: 0 };
  }

  const sourceNodes = model.nodes.filter((n) => sourceIds.has(n.id));
  const sourceMembers = model.members.filter((m) => sourceIds.has(m.a) && sourceIds.has(m.b));

  const alloc = makeAllocator(model, options.allocId);
  const nodes: NodeSpec3d[] = [...model.nodes];
  const members: MemberSpec3d[] = [...model.members];
  let addedNodes = 0;
  let addedMembers = 0;

  /** Maps source id → id on the previous layer (starts as identity). */
  let prevLayer = new Map<number, number>();
  for (const id of sourceIds) prevLayer.set(id, id);

  let lastLayer = prevLayer;

  for (let step = 1; step <= count; step++) {
    const layerMap = new Map<number, number>();
    for (const node of sourceNodes) {
      const id = alloc();
      nodes.push({
        id,
        x: node.x + offset.x * step,
        y: node.y + offset.y * step,
        z: node.z + offset.z * step,
      });
      layerMap.set(node.id, id);
      addedNodes++;
    }

    if (copyMembers) {
      for (const m of sourceMembers) {
        const a = layerMap.get(m.a);
        const b = layerMap.get(m.b);
        if (a === undefined || b === undefined) continue;
        members.push({
          ...m,
          id: alloc(),
          a,
          b,
          releaseA: { ...m.releaseA },
          releaseB: { ...m.releaseB },
          section: { ...m.section },
        });
        addedMembers++;
      }
    }

    if (connectLayers) {
      for (const srcId of sourceIds) {
        const from = prevLayer.get(srcId);
        const to = layerMap.get(srcId);
        if (from === undefined || to === undefined) continue;
        // Prefer the first source member's material/section as strut template;
        // fall back to the first model member if the selection has no members.
        const template = sourceMembers[0] ?? model.members[0];
        if (!template) continue;
        members.push({
          id: alloc(),
          a: from,
          b: to,
          material: template.material,
          section: { ...template.section },
          releaseA: { ...template.releaseA },
          releaseB: { ...template.releaseB },
          roll: 0,
          cableOnly: false,
        });
        addedMembers++;
      }
    }

    prevLayer = layerMap;
    lastLayer = layerMap;
  }

  return {
    model: { ...model, nodes, members },
    nodeMap: lastLayer,
    addedNodes,
    addedMembers,
  };
}

/** Array-copy without connecting struts. */
export function replicateModel3d(
  model: EditorModel3d,
  options: Omit<ExtrudeOptions, 'connectLayers'>,
): ExtrudeResult {
  return extrudeModel3d(model, { ...options, connectLayers: false });
}

/** Default extrude axis for a workplane: normal pointing "out". */
export function workplaneExtrudeAxis(plane: 'ground' | 'xz' | 'yz'): Vec3 {
  switch (plane) {
    case 'ground':
      return { x: 0, y: 0, z: 1 };
    case 'xz':
      return { x: 0, y: 1, z: 0 };
    case 'yz':
      return { x: 1, y: 0, z: 0 };
  }
}

export function scaleVec(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}
