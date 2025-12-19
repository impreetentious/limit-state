import { afterEach, describe, expect, it } from 'vitest';
import { useEditorStore } from '../editor-store';

afterEach(() => useEditorStore.getState().reset());

describe('editor store — M2 snapshots and build semantics', () => {
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
    const nodes = [store.addNode(0, 0), store.addNode(2, 0), store.addNode(4, 0), store.addNode(6, 0)];
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
});
