import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditorModel } from '../../fem/types';
import { prepareTraffic } from '../../stories/traffic';
import { defaultSection, useEditorStore } from '../editor-store';

afterEach(() => useEditorStore.getState().reset());

describe('editor store — snapshots and build semantics', () => {
  it('keeps stable IDs through delete, undo, and redo', () => {
    const store = useEditorStore.getState();
    const first = store.addNode(0, 0);
    const second = store.addNode(4, 0);
    const member = store.addMember(first, second);
    expect(member).toBe(1);

    useEditorStore.getState().deleteNode(first);
    expect(useEditorStore.getState().model.nodes).toEqual([{ id: second, x: 4, y: 0 }]);
    expect(useEditorStore.getState().model.members).toEqual([]);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.members).toHaveLength(1);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().model.nodes[0]?.id).toBe(second);
  });

  it('only extends deck paths from an endpoint', () => {
    const store = useEditorStore.getState();
    const nodes = [
      store.addNode(0, 0),
      store.addNode(2, 0),
      store.addNode(4, 0),
      store.addNode(6, 0),
    ];
    const first = useEditorStore.getState().addMember(nodes[0]!, nodes[1]!)!;
    const second = useEditorStore.getState().addMember(nodes[1]!, nodes[2]!)!;
    const third = useEditorStore.getState().addMember(nodes[2]!, nodes[3]!)!;

    useEditorStore.getState().toggleDeckMember(first);
    useEditorStore.getState().toggleDeckMember(third);
    expect(useEditorStore.getState().model.deck).toEqual([first]);
    expect(useEditorStore.getState().notice).toMatch(/contiguous/i);

    useEditorStore.getState().toggleDeckMember(second);
    useEditorStore.getState().toggleDeckMember(third);
    expect(useEditorStore.getState().model.deck).toEqual([first, second, third]);
  });

  it('cycles supports and caps history at 100 snapshots', () => {
    const store = useEditorStore.getState();
    const node = store.addNode(0, 0);
    useEditorStore.getState().cycleSupport(node);
    expect(useEditorStore.getState().model.supports[0]?.kind).toBe('pin');
    useEditorStore.getState().cycleSupport(node);
    expect(useEditorStore.getState().model.supports[0]?.kind).toBe('roller');
    useEditorStore.getState().cycleSupport(node);
    expect(useEditorStore.getState().model.supports[0]?.kind).toBe('fixed');
    useEditorStore.getState().cycleSupport(node);
    expect(useEditorStore.getState().model.supports).toEqual([]);

    for (let i = 0; i < 110; i++) useEditorStore.getState().setModelName(`Model ${i}`);
    expect(useEditorStore.getState().past).toHaveLength(100);
  });

  it('keeps the deck contiguous when a painted member or joining node is deleted', () => {
    const paint = () => {
      useEditorStore.getState().reset();
      const store = useEditorStore.getState();
      const nodes = [0, 4, 8, 12, 16].map((x) => store.addNode(x, 0));
      const members = [0, 1, 2, 3].map((index) =>
        useEditorStore.getState().addMember(nodes[index]!, nodes[index + 1]!)!,
      );
      for (const id of members) useEditorStore.getState().toggleDeckMember(id);
      return { nodes, members };
    };
    const contiguous = (deck: readonly number[]) => {
      const byId = new Map(useEditorStore.getState().model.members.map((m) => [m.id, m]));
      return deck.every((id, index) => {
        if (index === 0) return byId.has(id);
        const previous = byId.get(deck[index - 1]!)!;
        const current = byId.get(id)!;
        return (
          previous.a === current.a ||
          previous.a === current.b ||
          previous.b === current.a ||
          previous.b === current.b
        );
      });
    };

    // Deleting a member out of the middle of the path used to leave two
    // disjoint runs, which mesh.ts rejects — the whole model stopped analysing.
    let painted = paint();
    expect(useEditorStore.getState().model.deck).toHaveLength(4);
    useEditorStore.getState().deleteMember(painted.members[1]!);
    expect(contiguous(useEditorStore.getState().model.deck)).toBe(true);
    expect(useEditorStore.getState().model.deck.length).toBeGreaterThan(0);

    // Same for a node that two painted members share.
    painted = paint();
    useEditorStore.getState().deleteNode(painted.nodes[2]!);
    expect(contiguous(useEditorStore.getState().model.deck)).toBe(true);
  });
});

describe('editor structural edits', () => {
  beforeEach(() => {
    useEditorStore.setState({
      model: deckModel([1, 2]),
      selection: { kind: 'none' },
      past: [],
      future: [],
      notice: null,
    });
  });

  it('splits a member into continuous segments and preserves the deck route', () => {
    const nodeId = useEditorStore.getState().splitMember(1, 4, 0);
    const state = useEditorStore.getState();
    expect(nodeId).toBe(4);
    expect(state.model.nodes.find((node) => node.id === nodeId)).toMatchObject({ x: 4, y: 0 });
    expect(state.model.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1, a: 1, b: 4, releaseB: false }),
        expect.objectContaining({ id: 3, a: 4, b: 2, releaseA: false }),
      ]),
    );
    expect(state.model.deck).toEqual([1, 3, 2]);
    expect(prepareTraffic(state.model).length).toBe(16);
    expect(state.selection).toEqual({ kind: 'node', id: 4 });
  });

  it('retains a reversed traffic route when its member is split', () => {
    useEditorStore.setState({
      model: deckModel([2, 1]),
      past: [],
      future: [],
      selection: { kind: 'none' },
    });
    useEditorStore.getState().splitMember(1, 4, 0);
    const model = useEditorStore.getState().model;
    expect(model.deck).toEqual([2, 3, 1]);
    expect(prepareTraffic(model).length).toBe(16);
  });

  it('applies one material and section assignment to every selected member', () => {
    useEditorStore.getState().updateMembers([1, 2], {
      material: 'alu-6061',
      section: defaultSection('tube'),
    });
    const members = useEditorStore.getState().model.members;
    expect(members.map((member) => member.material)).toEqual(['alu-6061', 'alu-6061']);
    expect(members.map((member) => member.section.kind)).toEqual(['tube', 'tube']);
  });
});

function deckModel(deck: number[]): EditorModel {
  return {
    v: 1,
    name: 'deck fixture',
    seed: 1,
    nodes: [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 8, y: 0 },
      { id: 3, x: 16, y: 0 },
    ],
    members: [
      {
        id: 1,
        a: 1,
        b: 2,
        material: 'steel-s355',
        section: defaultSection('box'),
        releaseA: false,
        releaseB: false,
        cableOnly: false,
      },
      {
        id: 2,
        a: 2,
        b: 3,
        material: 'steel-s355',
        section: defaultSection('box'),
        releaseA: false,
        releaseB: false,
        cableOnly: false,
      },
    ],
    supports: [],
    loads: { gravity: false, points: [] },
    deck,
    story: { kind: 'traffic', weightkN: 300, speed: 12, movingMass: false },
  };
}
