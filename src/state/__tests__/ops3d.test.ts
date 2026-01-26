import { describe, expect, it } from 'vitest';
import { NO_RELEASES, type EditorModel3d } from '../../fem/space';
import {
  extrudeModel3d,
  replicateModel3d,
  scaleVec,
  workplaneExtrudeAxis,
} from '../ops3d';

const SECTION = { kind: 'box' as const, b: 0.2, h: 0.2, t: 0.008 };

/** Planar 2-bay bay on ground (XY): three nodes, two members. */
function planarBay(): EditorModel3d {
  return {
    v: 2,
    name: 'planar bay',
    seed: 1,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 4, y: 0, z: 0 },
      { id: 3, x: 8, y: 0, z: 0 },
    ],
    members: [
      {
        id: 1,
        a: 1,
        b: 2,
        material: 'steel-s355',
        section: SECTION,
        releaseA: NO_RELEASES,
        releaseB: NO_RELEASES,
        roll: 0,
      },
      {
        id: 2,
        a: 2,
        b: 3,
        material: 'steel-s355',
        section: SECTION,
        releaseA: NO_RELEASES,
        releaseB: NO_RELEASES,
        roll: 0,
      },
    ],
    supports: [
      { node: 1, kind: 'fixed' },
      { node: 3, kind: 'fixed' },
    ],
    loads: { gravity: false, points: [] },
  };
}

describe('extrude / replicate (Phase 3 editor)', () => {
  it('extrudes a planar bay into a spatial portal (nodes + roof + columns)', () => {
    const H = 5;
    const { model, addedNodes, addedMembers, nodeMap } = extrudeModel3d(planarBay(), {
      offset: scaleVec(workplaneExtrudeAxis('ground'), H),
      count: 1,
    });

    expect(addedNodes).toBe(3);
    // 2 roof members + 3 columns
    expect(addedMembers).toBe(5);
    expect(model.nodes).toHaveLength(6);
    expect(model.members).toHaveLength(7);

    // Images sit at z = H
    for (const [, imageId] of nodeMap) {
      const n = model.nodes.find((node) => node.id === imageId)!;
      expect(n.z).toBe(H);
    }

    // Column from node 1 → its image
    const col = model.members.find((m) => m.a === 1 && m.b === nodeMap.get(1));
    expect(col).toBeDefined();

    // Supports stay on the base only
    expect(model.supports).toEqual([
      { node: 1, kind: 'fixed' },
      { node: 3, kind: 'fixed' },
    ]);
  });

  it('replicates without connecting struts (bay array)', () => {
    const { model, addedMembers } = replicateModel3d(planarBay(), {
      offset: { x: 0, y: 4, z: 0 },
      count: 2,
    });
    // 2 copies × 2 in-plane members; no struts
    expect(addedMembers).toBe(4);
    expect(model.nodes).toHaveLength(9); // 3 + 3 + 3
    expect(model.members).toHaveLength(6); // 2 + 2 + 2
    // No member spans y = 0 → y = 4
    const cross = model.members.filter((m) => {
      const a = model.nodes.find((n) => n.id === m.a)!;
      const b = model.nodes.find((n) => n.id === m.b)!;
      return Math.abs(a.y - b.y) > 1e-9;
    });
    expect(cross).toHaveLength(0);
  });

  it('extrudes only a node subset and leaves outsiders alone', () => {
    const base = planarBay();
    const { model, addedNodes } = extrudeModel3d(base, {
      offset: { x: 0, y: 0, z: 3 },
      nodeIds: [1, 2],
    });
    expect(addedNodes).toBe(2);
    expect(model.nodes.find((n) => n.id === 3)).toEqual({ id: 3, x: 8, y: 0, z: 0 });
    // Only the member between 1–2 is copied; member 2–3 is not
    const atTop = model.members.filter((m) => {
      const a = model.nodes.find((n) => n.id === m.a)!;
      const b = model.nodes.find((n) => n.id === m.b)!;
      return a.z === 3 && b.z === 3;
    });
    expect(atTop).toHaveLength(1);
  });

  it('no-ops on zero offset', () => {
    const base = planarBay();
    const { model, addedNodes } = extrudeModel3d(base, { offset: { x: 0, y: 0, z: 0 } });
    expect(addedNodes).toBe(0);
    expect(model).toBe(base);
  });

  it('workplane normals point out of each draw plane', () => {
    expect(workplaneExtrudeAxis('ground')).toEqual({ x: 0, y: 0, z: 1 });
    expect(workplaneExtrudeAxis('xz')).toEqual({ x: 0, y: 1, z: 0 });
    expect(workplaneExtrudeAxis('yz')).toEqual({ x: 1, y: 0, z: 0 });
  });
});
