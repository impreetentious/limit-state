/**
 * Phase 4G tests — 3D editor undo/redo + member-limit enforcement.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MEMBER_HARD_LIMIT_3D, useEditorStore3d } from '../editor-store-3d';

afterEach(() => useEditorStore3d.getState().reset());

describe('3D editor store — Phase 4G undo/redo + limit', () => {
  it('undoes node/member additions and redoes them', () => {
    const store = useEditorStore3d.getState();
    const a = store.addNodeAt(0, 0, 0);
    const b = store.addNodeAt(4, 0, 0);
    store.addMemberBetween(a, b);
    expect(useEditorStore3d.getState().model.members).toHaveLength(1);

    useEditorStore3d.getState().undo();
    expect(useEditorStore3d.getState().model.members).toHaveLength(0);

    useEditorStore3d.getState().redo();
    expect(useEditorStore3d.getState().model.members).toHaveLength(1);
  });

  it('rejects new members past MEMBER_HARD_LIMIT_3D', () => {
    const store = useEditorStore3d.getState();
    // Build a dense chain of nodes and members up to the limit.
    const nodes: number[] = [];
    for (let i = 0; i <= MEMBER_HARD_LIMIT_3D; i++) nodes.push(store.addNodeAt(i, 0, 0));
    for (let i = 0; i < MEMBER_HARD_LIMIT_3D; i++) {
      useEditorStore3d.getState().addMemberBetween(nodes[i]!, nodes[i + 1]!);
    }
    expect(useEditorStore3d.getState().model.members.length).toBe(MEMBER_HARD_LIMIT_3D);
    // One more must be rejected with a notice.
    const another = useEditorStore3d.getState().addNodeAt(999, 0, 0);
    useEditorStore3d.getState().addMemberBetween(nodes[0]!, another);
    expect(useEditorStore3d.getState().model.members.length).toBe(MEMBER_HARD_LIMIT_3D);
    expect(useEditorStore3d.getState().notice).toMatch(/limit/i);
  });

  it('G36: loadModel and reset both clear history', () => {
    const store = useEditorStore3d.getState();
    store.addNodeAt(0, 0, 0);
    expect(useEditorStore3d.getState().past.length).toBeGreaterThan(0);
    const model = useEditorStore3d.getState().model;
    store.undo();
    expect(useEditorStore3d.getState().future.length).toBeGreaterThan(0);
    store.loadModel(model);
    expect(useEditorStore3d.getState().past).toEqual([]);
    expect(useEditorStore3d.getState().future).toEqual([]);
    store.addNodeAt(0, 0, 0);
    expect(useEditorStore3d.getState().past.length).toBeGreaterThan(0);
    useEditorStore3d.getState().reset();
    expect(useEditorStore3d.getState().past).toEqual([]);
    expect(useEditorStore3d.getState().future).toEqual([]);
  });

  it('persists independent 3D Timoshenko and P-Δ analysis toggles', () => {
    const store = useEditorStore3d.getState();
    store.setShearFlexible(true);
    store.setSecondOrder(true);
    expect(useEditorStore3d.getState()).toMatchObject({ shearFlexible: true, secondOrder: true });
  });

  it('updates selected 3D member and node inspection fields', () => {
    const store = useEditorStore3d.getState();
    const a = store.addNodeAt(0, 0, 0);
    const b = store.addNodeAt(4, 0, 0);
    store.addMemberBetween(a, b);
    const memberId = useEditorStore3d.getState().model.members[0]!.id;
    useEditorStore3d.getState().updateNode(b, 4, 2, 1);
    useEditorStore3d.getState().setSupport(a, 'rollerZ');
    useEditorStore3d.getState().updateMember(memberId, {
      roll: Math.PI / 4,
      releaseA: { tx: true, ty: false, tz: true },
      cableOnly: true,
    });
    expect(useEditorStore3d.getState().model.nodes.find((node) => node.id === b)).toMatchObject({
      x: 4,
      y: 2,
      z: 1,
    });
    expect(useEditorStore3d.getState().model.supports).toContainEqual({ node: a, kind: 'rollerZ' });
    expect(useEditorStore3d.getState().model.members[0]).toMatchObject({
      roll: Math.PI / 4,
      releaseA: { tx: true, ty: false, tz: true },
      cableOnly: true,
    });
  });

  it('applies a bulk section assignment to a multi-member selection', () => {
    const store = useEditorStore3d.getState();
    const a = store.addNodeAt(0, 0, 0);
    const b = store.addNodeAt(4, 0, 0);
    const c = store.addNodeAt(8, 0, 0);
    store.addMemberBetween(a, b);
    store.addMemberBetween(b, c);
    const ids = useEditorStore3d.getState().model.members.map((member) => member.id);
    useEditorStore3d.getState().setSelection({ kind: 'members', ids });
    useEditorStore3d.getState().updateMembers(ids, { section: { kind: 'tube', d: 0.2, t: 0.01 } });
    expect(useEditorStore3d.getState().model.members.map((member) => member.section)).toEqual([
      { kind: 'tube', d: 0.2, t: 0.01 },
      { kind: 'tube', d: 0.2, t: 0.01 },
    ]);
  });
});
