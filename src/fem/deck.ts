/**
 * Contiguous deck-path geometry shared by traffic and influence-line sweeps.
 */
import type { AnalysisMesh, EditorModel } from './types';

export interface DeckSegment {
  memberId: number;
  startNode: number;
  endNode: number;
  length: number;
  elements: Array<{ index: number; reversed: boolean }>;
}

export interface DeckStationHit {
  station: number;
  element: number;
  xi: number;
  x: number;
  y: number;
}

/** Ordered deck segments with analysis-element coverage along the painted path. */
export function buildDeckRoute(model: EditorModel, mesh: AnalysisMesh): DeckSegment[] {
  if (model.deck.length === 0) throw new Error('Paint a contiguous deck before running a deck sweep.');
  const members = new Map(model.members.map((member) => [member.id, member]));
  const first = members.get(model.deck[0]!);
  if (!first) throw new Error('Deck references a missing member.');
  let current = first.a;
  if (model.deck.length > 1) {
    const next = members.get(model.deck[1]!);
    if (!next) throw new Error('Deck references a missing member.');
    const shared = [first.a, first.b].find((node) => node === next.a || node === next.b);
    if (shared !== undefined) current = current === shared ? first.b : first.a;
  }
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const route: DeckSegment[] = [];
  for (const id of model.deck) {
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
      length: Math.hypot(end.x - start.x, end.y - start.y),
      elements: (reversed ? [...elementIndices].reverse() : elementIndices).map((index) => ({ index, reversed })),
    });
    current = endNode;
  }
  return route;
}

/** Map a deck station (m) onto the owning analysis element and Hermite ξ. */
export function mapDeckStation(
  model: EditorModel,
  mesh: AnalysisMesh,
  route: readonly DeckSegment[],
  station: number,
): DeckStationHit[] {
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
        }];
      }
      withinMember -= element.L;
    }
    return [];
  }
  return [];
}

/** Editor-node id → analysis-mesh node index. */
export function editorNodeIndex(mesh: AnalysisMesh): Map<number, number> {
  const index = new Map<number, number>();
  for (let node = 0; node < mesh.editorNode.length; node++) {
    const id = mesh.editorNode[node]!;
    if (id >= 0) index.set(id, node);
  }
  return index;
}

/** Total painted-deck length in metres. */
export function deckLength(route: readonly DeckSegment[]): number {
  return route.reduce((sum, segment) => sum + segment.length, 0);
}
