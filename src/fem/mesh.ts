/**
 * EditorModel -> AnalysisMesh: subdivide each member into 2 elements (mid-node),
 * number DOFs, apply supports to the free-DOF list, validate deck contiguity.
 * docs/FEM-SPEC.md §4.4 / §14 2A.
 */
import { MATERIALS, sectionProps } from './materials';
import type { AnalysisMesh, AnalysisOptions, EditorModel, MemberSpec, SupportSpec } from './types';

/**
 * Build the hidden two-element-per-member analysis mesh from an editor model.
 * docs/FEM-SPEC.md §4.4.
 */
export function buildMesh(model: EditorModel, options: AnalysisOptions = {}): AnalysisMesh {
  const nodeById = new Map<number, { index: number; x: number; y: number }>();
  const coords: number[] = [];
  const editorNode: number[] = [];

  for (const node of model.nodes) {
    if (!Number.isInteger(node.id) || nodeById.has(node.id)) {
      throw new Error(`Node ids must be unique integers (received ${node.id}).`);
    }
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      throw new Error(`Node ${node.id} has non-finite coordinates.`);
    }
    const index = editorNode.length;
    nodeById.set(node.id, { index, x: node.x, y: node.y });
    coords.push(node.x, node.y);
    editorNode.push(node.id);
  }

  validateSupports(model.supports, nodeById);
  const elements: AnalysisMesh['elements'] = [];
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
    const memberLength = Math.hypot(dx, dy);
    if (!(memberLength > 0)) throw new Error(`Member ${member.id} has zero length.`);

    const props = sectionProps(member.section);
    const material = MATERIALS[member.material];
    const common = {
      memberId: member.id,
      E: material.E,
      G: material.G,
      A: props.A,
      As: props.As,
      I: props.I,
      c: props.c,
      rho: material.rho,
      fy: material.fy,
      cos: dx / memberLength,
      sin: dy / memberLength,
    };

    // A member released at both physical ends, or a tension-only cable, is an
    // exact axial truss bar. Subdividing it would add an artificial collinear
    // node with an unrestrained transverse DOF. docs/FEM-SPEC.md §4.4 / §14 2E.
    const truss = member.cableOnly || (member.releaseA && member.releaseB);
    if (truss) {
      elements.push({
        ...common,
        na: a.index,
        nb: b.index,
        L: memberLength,
        releaseA: true,
        releaseB: true,
      });
      continue;
    }

    const mid = editorNode.length;
    coords.push((a.x + b.x) / 2, (a.y + b.y) / 2);
    editorNode.push(-1);
    elements.push({
      ...common,
      na: a.index,
      nb: mid,
      L: memberLength / 2,
      releaseA: member.releaseA,
      releaseB: false,
    });
    elements.push({
      ...common,
      na: mid,
      nb: b.index,
      L: memberLength / 2,
      releaseA: false,
      releaseB: member.releaseB,
    });
  }

  validateDeck(model.deck, model.members, memberIds);

  const constrained = new Set<number>();
  for (const support of model.supports) {
    const node = nodeById.get(support.node);
    if (!node) continue; // validateSupports has already made this impossible.
    if (support.kind === 'pin' || support.kind === 'fixed') {
      constrained.add(3 * node.index);
      constrained.add(3 * node.index + 1);
    } else if (support.kind === 'roller') {
      // A 2D roller bears vertically and leaves the horizontal DOF free.
      constrained.add(3 * node.index + 1);
    }
    if (support.kind === 'fixed') constrained.add(3 * node.index + 2);
  }

  // Rotations connected only to released member ends have no stiffness. They
  // are kinematically inactive rather than structural mechanisms, so exclude
  // them from K_ff just as we exclude support-constrained DOFs.
  const activeRotation = Array.from({ length: editorNode.length }, () => false);
  for (const element of elements) {
    if (!element.releaseA) activeRotation[element.na] = true;
    if (!element.releaseB) activeRotation[element.nb] = true;
  }

  const ndof = editorNode.length * 3;
  const freeDofs: number[] = [];
  for (let node = 0; node < editorNode.length; node++) {
    for (let component = 0; component < 3; component++) {
      const dof = 3 * node + component;
      if (constrained.has(dof)) continue;
      if (component === 2 && !activeRotation[node]) continue;
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

function validateSupports(
  supports: SupportSpec[],
  nodes: ReadonlyMap<number, { index: number; x: number; y: number }>,
): void {
  const supported = new Set<number>();
  for (const support of supports) {
    if (!nodes.has(support.node))
      throw new Error(`Support references missing node ${support.node}.`);
    if (supported.has(support.node))
      throw new Error(`Node ${support.node} has more than one support.`);
    supported.add(support.node);
  }
}

function validateDeck(deck: number[], members: MemberSpec[], memberIds: ReadonlySet<number>): void {
  if (deck.length === 0) return;
  const byId = new Map(members.map((member) => [member.id, member]));
  for (const memberId of deck) {
    if (!memberIds.has(memberId)) throw new Error(`Deck references missing member ${memberId}.`);
  }
  for (let i = 1; i < deck.length; i++) {
    const previous = byId.get(deck[i - 1]!);
    const current = byId.get(deck[i]!);
    if (!previous || !current) continue;
    const shared =
      previous.a === current.a ||
      previous.a === current.b ||
      previous.b === current.a ||
      previous.b === current.b;
    if (!shared) throw new Error('Deck members must form one contiguous path.');
  }
}
