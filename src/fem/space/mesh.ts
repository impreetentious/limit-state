/**
 * EditorModel3d → AnalysisMesh3d. Same meshing policy as 2D (§4.4): two
 * analysis elements per frame member; both-ends-released stays one bar.
 */
import { MATERIALS, sectionProps } from '../materials';
import { memberTriad } from './assemble';
import type { AnalysisMesh3d, AnalysisOptions3d, EditorModel3d, Element3d, EndReleases3d, MemberSpec3d, SupportSpec3d } from './types';
import { NO_RELEASES, TRUSS_RELEASES } from './types';

/** Build the 3D analysis mesh. */
export function buildMesh3d(model: EditorModel3d, options: AnalysisOptions3d = {}): AnalysisMesh3d {
  const nodeById = new Map<number, { index: number; x: number; y: number; z: number }>();
  const coords: number[] = [];
  const editorNode: number[] = [];

  for (const node of model.nodes) {
    if (!Number.isInteger(node.id) || nodeById.has(node.id)) {
      throw new Error(`Node ids must be unique integers (received ${node.id}).`);
    }
    if (![node.x, node.y, node.z].every(Number.isFinite)) {
      throw new Error(`Node ${node.id} has non-finite coordinates.`);
    }
    const index = editorNode.length;
    nodeById.set(node.id, { index, x: node.x, y: node.y, z: node.z });
    coords.push(node.x, node.y, node.z);
    editorNode.push(node.id);
  }

  validateSupports(model.supports, nodeById);
  const elements: Element3d[] = [];
  const memberIds = new Set<number>();

  for (const member of model.members) {
    if (!Number.isInteger(member.id) || memberIds.has(member.id)) {
      throw new Error(`Member ids must be unique integers (received ${member.id}).`);
    }
    memberIds.add(member.id);
    const a = nodeById.get(member.a);
    const b = nodeById.get(member.b);
    if (!a || !b) throw new Error(`Member ${member.id} references a missing node.`);
    if (a.index === b.index) throw new Error(`Member ${member.id} has identical endpoints.`);

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const memberLength = Math.hypot(dx, dy, dz);
    if (!(memberLength > 0)) throw new Error(`Member ${member.id} has zero length.`);

    const props = sectionProps(member.section);
    const material = MATERIALS[member.material];
    const R = memberTriad(dx, dy, dz, member.roll);
    const common = {
      memberId: member.id,
      E: material.E,
      G: material.G,
      A: props.A,
      Iy: props.Iy,
      Iz: props.Iz,
      J: props.J,
      c: props.c,
      fy: material.fy,
      rho: material.rho,
      R,
      As: props.As,
    };

    const truss = member.cableOnly || (isFullRelease(member.releaseA) && isFullRelease(member.releaseB));
    if (truss) {
      // Cables / axial bars: release bending; keep torsion unless both ends fully released.
      const releases = member.cableOnly
        ? { tx: false, ty: true, tz: true }
        : TRUSS_RELEASES;
      elements.push({
        ...common,
        na: a.index,
        nb: b.index,
        L: memberLength,
        releaseA: releases,
        releaseB: releases,
      });
      continue;
    }

    const mid = editorNode.length;
    coords.push((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    editorNode.push(-1);
    elements.push({
      ...common,
      na: a.index,
      nb: mid,
      L: memberLength / 2,
      releaseA: member.releaseA,
      releaseB: NO_RELEASES,
    });
    elements.push({
      ...common,
      na: mid,
      nb: b.index,
      L: memberLength / 2,
      releaseA: NO_RELEASES,
      releaseB: member.releaseB,
    });
  }

  const constrained = constrainedDofs(model.supports, nodeById);

  // Rotations connected only to released ends are kinematically inactive.
  const nNodes = editorNode.length;
  const activeTx = Array.from({ length: nNodes }, () => false);
  const activeTy = Array.from({ length: nNodes }, () => false);
  const activeTz = Array.from({ length: nNodes }, () => false);
  for (const element of elements) {
    markActive(activeTx, activeTy, activeTz, element.na, element.releaseA);
    markActive(activeTx, activeTy, activeTz, element.nb, element.releaseB);
  }

  const ndof = nNodes * 6;
  const freeDofs: number[] = [];
  for (let node = 0; node < nNodes; node++) {
    for (let component = 0; component < 6; component++) {
      const dof = 6 * node + component;
      if (constrained.has(dof)) continue;
      if (component === 3 && !activeTx[node]) continue;
      if (component === 4 && !activeTy[node]) continue;
      if (component === 5 && !activeTz[node]) continue;
      freeDofs.push(dof);
    }
  }

  return {
    coords: Float64Array.from(coords),
    elements,
    editorNode: Int32Array.from(editorNode),
    freeDofs: Int32Array.from(freeDofs),
    ndof,
    shearFlexible: options.shearFlexible === true,
  };
}

function isFullRelease(r: EndReleases3d): boolean {
  return r.tx && r.ty && r.tz;
}

function markActive(
  tx: boolean[],
  ty: boolean[],
  tz: boolean[],
  node: number,
  release: EndReleases3d,
): void {
  if (!release.tx) tx[node] = true;
  if (!release.ty) ty[node] = true;
  if (!release.tz) tz[node] = true;
}

function constrainedDofs(
  supports: SupportSpec3d[],
  nodes: ReadonlyMap<number, { index: number }>,
): Set<number> {
  const constrained = new Set<number>();
  for (const support of supports) {
    const node = nodes.get(support.node);
    if (!node) continue;
    const base = 6 * node.index;
    switch (support.kind) {
      case 'pin':
        constrained.add(base);
        constrained.add(base + 1);
        constrained.add(base + 2);
        break;
      case 'rollerX':
        constrained.add(base);
        break;
      case 'rollerY':
        constrained.add(base + 1);
        break;
      case 'rollerZ':
        constrained.add(base + 2);
        break;
      case 'fixed':
        for (let i = 0; i < 6; i++) constrained.add(base + i);
        break;
    }
  }
  return constrained;
}

function validateSupports(
  supports: SupportSpec3d[],
  nodes: ReadonlyMap<number, { index: number }>,
): void {
  const supported = new Set<number>();
  for (const support of supports) {
    if (!nodes.has(support.node)) throw new Error(`Support references missing node ${support.node}.`);
    if (supported.has(support.node)) throw new Error(`Node ${support.node} has more than one support.`);
    supported.add(support.node);
  }
}

/** Convenience: planar XY cantilever matching the 2D G1 setup. Gate G23. */
export function planarCantileverModel(opts?: {
  L?: number;
  section?: MemberSpec3d['section'];
  material?: MemberSpec3d['material'];
}): EditorModel3d {
  const L = opts?.L ?? 1;
  return {
    v: 2,
    name: 'planar-cantilever',
    seed: 0,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: L, y: 0, z: 0 },
    ],
    members: [
      {
        id: 1,
        a: 1,
        b: 2,
        material: opts?.material ?? 'steel-s355',
        section: opts?.section ?? { kind: 'rect', b: 0.1, h: 0.2 },
        releaseA: NO_RELEASES,
        releaseB: NO_RELEASES,
        roll: 0,
        cableOnly: false,
      },
    ],
    supports: [{ node: 1, kind: 'fixed' }],
    loads: { gravity: false, points: [] },
  };
}
