/**
 * 3D failure taxonomy, ramp capacity, and quasi-static collapse cascade.
 */
import { assembleLoadCase3d } from './assemble';
import { modelHasCables3d, scaleLoadAssembly3d, solveTensionOnly3d } from './cables';
import { buckling3d } from './eigen';
import { buildMesh3d } from './mesh';
import { solveStatic3d, type StaticAnalysis3d } from './statics';
import type { AnalysisMesh3d, EditorModel3d, EndReleases3d, MemberSpec3d } from './types';
import type { CascadeResult, FailureReport } from '../types';

/**
 * Evaluate static failure classes at one proportional load factor.
 */
export function evaluateFailure3d(model: EditorModel3d, loadFactor: number): FailureReport {
  if (!(loadFactor > 0) || !Number.isFinite(loadFactor)) throw new Error('Failure evaluation needs a finite positive load factor.');
  const analysis = analyzeAtFactor3d(model, loadFactor);
  if (analysis.kind === 'mechanism') {
    return { kind: 'mechanism', nodeId: analysis.nodeId };
  }
  if (analysis.kind === 'invalid') throw new Error(analysis.message);
  if (analysis.kind !== 'stable') throw new Error('Failure evaluation needs a stable static solve.');

  const yieldState = governingYield3d(analysis);
  const memberBuckling = governingMemberBuckling3d(analysis.mesh, analysis.result.elementForces);
  const globalBuckling = governingGlobalBuckling3d(analysis.mesh, analysis.result.elementForces);
  if (yieldState.utilization >= 1 && yieldState.utilization >= memberBuckling.ratio && yieldState.utilization >= globalBuckling.ratio) {
    return { kind: 'yield', memberId: yieldState.memberId, utilization: yieldState.utilization, loadFactor };
  }
  if (memberBuckling.ratio >= 1 && memberBuckling.ratio >= globalBuckling.ratio) {
    return {
      kind: 'buckling',
      governs: 'member',
      memberId: memberBuckling.memberId,
      lambdaCr: loadFactor / memberBuckling.ratio,
      memberN: memberBuckling.N,
      memberNCr: memberBuckling.Ncr,
    };
  }
  if (globalBuckling.ratio >= 1) {
    return { kind: 'buckling', governs: 'global', memberId: globalBuckling.memberId, lambdaCr: globalBuckling.capacityFactor };
  }

  const yieldCapacity = yieldState.utilization > 0 ? loadFactor / yieldState.utilization : Infinity;
  const memberCapacity = memberBuckling.ratio > 0 ? loadFactor / memberBuckling.ratio : Infinity;
  const globalCapacity = globalBuckling.capacityFactor;
  const capacityFactor = Math.min(yieldCapacity, memberCapacity, globalCapacity);
  if (capacityFactor === yieldCapacity) return { kind: 'stable', capacityFactor, governedBy: 'yield', memberId: yieldState.memberId };
  return { kind: 'stable', capacityFactor, governedBy: 'buckling', memberId: memberCapacity <= globalCapacity ? memberBuckling.memberId : globalBuckling.memberId };
}

/**
 * Deterministic quasi-static collapse cascade for space frames.
 * Hinge insertion releases θy+θz at the governing end.
 */
export function collapseCascade3d(model: EditorModel3d, loadFactor = 1): CascadeResult {
  if (!(loadFactor > 0) || !Number.isFinite(loadFactor)) throw new Error('Collapse cascade needs a finite positive load factor.');
  let current = cloneModel3d(model);
  const steps: CascadeResult['steps'] = [];
  for (let index = 0; index < 20; index++) {
    const report = evaluateFailure3d(current, loadFactor);
    if (report.kind === 'mechanism') return { steps, outcome: 'collapse' };
    if (report.kind === 'stable') return { steps, outcome: 'stable' };
    if (report.kind === 'resonance') return { steps, outcome: 'stable' };
    const memberId = report.memberId;
    const member = current.members.find((candidate) => candidate.id === memberId);
    if (!member) return { steps, outcome: 'collapse' };
    const analysis = analyzeAtFactor3d(current, loadFactor);
    if (analysis.kind !== 'stable') return { steps, outcome: 'collapse' };
    const axialDominant = memberAxialDominant3d(analysis.mesh, analysis.result.elementForces, memberId);
    if (report.kind === 'buckling' || axialDominant) {
      current = removeMember3d(current, memberId);
      steps.push({ action: 'remove', memberId, detail: `Member ${memberId} buckled/was axial-governing and was removed.` });
      continue;
    }
    const releaseAt = governingMomentEnd3d(analysis.mesh, analysis.result.elementForces, memberId);
    if (releaseAt === 'a' && !isBendingReleased(member.releaseA)) {
      current = patchMember3d(current, memberId, { releaseA: hingeRelease(member.releaseA) });
      steps.push({ action: 'hinge', memberId, detail: `Hinge inserted at member ${memberId} end A after bending yield.` });
    } else if (releaseAt === 'b' && !isBendingReleased(member.releaseB)) {
      current = patchMember3d(current, memberId, { releaseB: hingeRelease(member.releaseB) });
      steps.push({ action: 'hinge', memberId, detail: `Hinge inserted at member ${memberId} end B after bending yield.` });
    } else {
      current = removeMember3d(current, memberId);
      steps.push({ action: 'remove', memberId, detail: `Member ${memberId} could not take another hinge and was removed.` });
    }
  }
  return { steps, outcome: 'stable' };
}

/** Solve the base load case at a proportional ramp factor. */
export function analyzeAtFactor3d(model: EditorModel3d, factor: number): StaticAnalysis3d {
  if (!(factor > 0) || !Number.isFinite(factor)) return { kind: 'invalid', message: 'Ramp factor must be finite and positive.' };
  try {
    if (modelHasCables3d(model)) return solveTensionOnly3d(model, factor).analysis;
    const mesh = buildMesh3d(model);
    const nodeIndex = new Map<number, number>();
    for (let index = 0; index < mesh.editorNode.length; index++) {
      const id = mesh.editorNode[index]!;
      if (id >= 0) nodeIndex.set(id, index);
    }
    const points = model.loads.points.flatMap((point) => {
      const meshNode = nodeIndex.get(point.node);
      return meshNode === undefined
        ? []
        : [{ meshNode, fx: point.fx, fy: point.fy, fz: point.fz, mx: point.mx, my: point.my, mz: point.mz }];
    });
    const base = assembleLoadCase3d(mesh, { gravity: model.loads.gravity, points });
    const loads = scaleLoadAssembly3d(base, factor);
    return solveStatic3d(mesh, loads.F, undefined, loads.elementFixedEnd);
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : 'Ramp analysis could not run.' };
  }
}

function governingYield3d(analysis: Extract<StaticAnalysis3d, { kind: 'stable' }>): { memberId: number; utilization: number } {
  let memberId = -1;
  let utilization = 0;
  for (const [id, value] of analysis.result.utilization) {
    if (value > utilization) {
      memberId = id;
      utilization = value;
    }
  }
  return { memberId, utilization };
}

/** Per-member Euler |N| / (π² E I_min / L²). */
function governingMemberBuckling3d(
  mesh: AnalysisMesh3d,
  forces: Float64Array,
): { memberId: number; ratio: number; N: number; Ncr: number } {
  const lengths = new Map<number, number>();
  const compression = new Map<number, number>();
  const properties = new Map<number, { E: number; Imin: number }>();
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    lengths.set(element.memberId, (lengths.get(element.memberId) ?? 0) + element.L);
    properties.set(element.memberId, { E: element.E, Imin: Math.min(element.Iy, element.Iz) });
    const N = -forces[index * 12]!; // tension-positive
    compression.set(element.memberId, Math.max(compression.get(element.memberId) ?? 0, -N));
  }
  let result = { memberId: -1, ratio: 0, N: 0, Ncr: Infinity };
  for (const [memberId, N] of compression) {
    const property = properties.get(memberId)!;
    const length = lengths.get(memberId)!;
    const Ncr = (Math.PI ** 2 * property.E * property.Imin) / (length * length);
    const ratio = N / Ncr;
    if (ratio > result.ratio) result = { memberId, ratio, N, Ncr };
  }
  return result;
}

function governingGlobalBuckling3d(
  mesh: AnalysisMesh3d,
  forces: Float64Array,
): { memberId: number; ratio: number; capacityFactor: number } {
  const N = new Float64Array(mesh.elements.length);
  let hasCompression = false;
  let memberId = -1;
  let greatestCompression = 0;
  for (let index = 0; index < N.length; index++) {
    N[index] = -forces[index * 12]!; // tension-positive
    if (N[index]! < 0) {
      hasCompression = true;
      if (-N[index]! > greatestCompression) {
        greatestCompression = -N[index]!;
        memberId = mesh.elements[index]!.memberId;
      }
    }
  }
  if (!hasCompression) return { memberId, ratio: 0, capacityFactor: Infinity };
  const result = buckling3d(mesh, N);
  const currentFactor = result.values[0] ?? Infinity;
  return { memberId, ratio: currentFactor === Infinity ? 0 : 1 / currentFactor, capacityFactor: currentFactor };
}

function memberAxialDominant3d(mesh: AnalysisMesh3d, forces: Float64Array, memberId: number): boolean {
  let axial = 0;
  let combined = 0;
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    if (element.memberId !== memberId) continue;
    const base = index * 12;
    const N = Math.abs(-forces[base]! / element.A);
    const cy = element.c ?? 0;
    const cz = element.c ?? 0;
    const Ma = Math.abs(forces[base + 4]!) * cy / Math.max(element.Iy, 1e-30)
      + Math.abs(forces[base + 5]!) * cz / Math.max(element.Iz, 1e-30);
    const Mb = Math.abs(forces[base + 10]!) * cy / Math.max(element.Iy, 1e-30)
      + Math.abs(forces[base + 11]!) * cz / Math.max(element.Iz, 1e-30);
    axial = Math.max(axial, N);
    combined = Math.max(combined, N + Ma, N + Mb);
  }
  return combined > 0 && axial / combined >= 0.8;
}

function governingMomentEnd3d(mesh: AnalysisMesh3d, forces: Float64Array, memberId: number): 'a' | 'b' {
  let end: 'a' | 'b' = 'a';
  let maximum = -Infinity;
  for (let index = 0; index < mesh.elements.length; index++) {
    if (mesh.elements[index]!.memberId !== memberId) continue;
    const a = Math.hypot(forces[index * 12 + 4]!, forces[index * 12 + 5]!);
    const b = Math.hypot(forces[index * 12 + 10]!, forces[index * 12 + 11]!);
    if (a > maximum) { maximum = a; end = 'a'; }
    if (b > maximum) { maximum = b; end = 'b'; }
  }
  return end;
}

function isBendingReleased(release: EndReleases3d): boolean {
  return release.ty && release.tz;
}

function hingeRelease(release: EndReleases3d): EndReleases3d {
  return { ...release, ty: true, tz: true };
}

function cloneModel3d(model: EditorModel3d): EditorModel3d {
  return {
    ...model,
    nodes: model.nodes.map((node) => ({ ...node })),
    members: model.members.map((member) => ({
      ...member,
      section: { ...member.section },
      releaseA: { ...member.releaseA },
      releaseB: { ...member.releaseB },
    })),
    supports: model.supports.map((support) => ({ ...support })),
    loads: { ...model.loads, points: model.loads.points.map((point) => ({ ...point })) },
    deck: model.deck ? [...model.deck] : undefined,
    story: model.story ? { ...model.story } : undefined,
  };
}

function removeMember3d(model: EditorModel3d, memberId: number): EditorModel3d {
  return {
    ...model,
    members: model.members.filter((member) => member.id !== memberId),
    deck: (model.deck ?? []).filter((id) => id !== memberId),
  };
}

function patchMember3d(model: EditorModel3d, memberId: number, patch: Partial<MemberSpec3d>): EditorModel3d {
  return {
    ...model,
    members: model.members.map((member) => (member.id === memberId ? { ...member, ...patch } : member)),
  };
}
