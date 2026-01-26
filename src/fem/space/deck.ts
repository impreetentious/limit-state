/**
 * Contiguous 3D deck-path geometry for traffic sweeps.
 * The traffic path is a 3D polyline.
 */
import type { AnalysisMesh3d, EditorModel3d } from './types';

export interface DeckSegment3d {
  memberId: number;
  startNode: number;
  endNode: number;
  length: number;
  elements: Array<{ index: number; reversed: boolean }>;
}

export interface DeckStationHit3d {
  station: number;
  element: number;
  xi: number;
  x: number;
  y: number;
  z: number;
}

/** Ordered deck segments with analysis-element coverage. */
export function buildDeckRoute3d(model: EditorModel3d, mesh: AnalysisMesh3d): DeckSegment3d[] {
  const deck = model.deck ?? [];
  if (deck.length === 0) throw new Error('Paint a contiguous deck before running a deck sweep.');
  const members = new Map(model.members.map((member) => [member.id, member]));
  const first = members.get(deck[0]!);
  if (!first) throw new Error('Deck references a missing member.');
  let current = first.a;
  if (deck.length > 1) {
    const next = members.get(deck[1]!);
    if (!next) throw new Error('Deck references a missing member.');
    const shared = [first.a, first.b].find((node) => node === next.a || node === next.b);
    if (shared !== undefined) current = current === shared ? first.b : first.a;
  }
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const route: DeckSegment3d[] = [];
  for (const id of deck) {
    const member = members.get(id);
    if (!member) throw new Error('Deck references a missing member.');
    const reversed = member.b === current;
    if (!reversed && member.a !== current) throw new Error('Deck members must form one continuous route.');
    const startNode = current;
    const endNode = reversed ? member.a : member.b;
    const start = nodeById.get(startNode);
    const end = nodeById.get(endNode);
    if (!start || !end) throw new Error('Deck references a missing node.');
    const elementIndices = mesh.elements.flatMap((element, index) => (element.memberId === id ? [index] : []));
    route.push({
      memberId: id,
      startNode,
      endNode,
      length: Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z),
      elements: (reversed ? [...elementIndices].reverse() : elementIndices).map((index) => ({ index, reversed })),
    });
    current = endNode;
  }
  return route;
}

/** Map a deck station (m) onto element ξ and world position. */
export function mapDeckStation3d(
  model: EditorModel3d,
  mesh: AnalysisMesh3d,
  route: readonly DeckSegment3d[],
  station: number,
): DeckStationHit3d[] {
  if (station < 0) return [];
  let remaining = station;
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  for (const segment of route) {
    if (remaining > segment.length) {
      remaining -= segment.length;
      continue;
    }
    const start = nodes.get(segment.startNode)!;
    const end = nodes.get(segment.endNode)!;
    const fraction = segment.length === 0 ? 0 : remaining / segment.length;
    let withinMember = remaining;
    for (const item of segment.elements) {
      const element = mesh.elements[item.index]!;
      if (withinMember <= element.L || item === segment.elements.at(-1)) {
        const localFraction = Math.max(0, Math.min(1, withinMember / element.L));
        return [{
          station,
          element: item.index,
          xi: item.reversed ? 1 - localFraction : localFraction,
          x: start.x + (end.x - start.x) * fraction,
          y: start.y + (end.y - start.y) * fraction,
          z: start.z + (end.z - start.z) * fraction,
        }];
      }
      withinMember -= element.L;
    }
    return [];
  }
  return [];
}

export function editorNodeIndex3d(mesh: AnalysisMesh3d): Map<number, number> {
  const index = new Map<number, number>();
  for (let node = 0; node < mesh.editorNode.length; node++) {
    const id = mesh.editorNode[node]!;
    if (id >= 0) index.set(id, node);
  }
  return index;
}

export function deckLength3d(route: readonly DeckSegment3d[]): number {
  return route.reduce((sum, segment) => sum + segment.length, 0);
}
