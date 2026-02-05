/**
 * Failure taxonomy evaluation (mechanism / yield / buckling / resonance),
 * exact load-ramp capacity (linearity ⇒ λ_yield = 1/max U), and the
 * quasi-static collapse cascade. M6.
 */
import { assembleLoadCase, type LoadAssembly } from './assemble';
import { modelHasCables, solveTensionOnly } from './cables';
import { buckling } from './eigen';
import { buildMesh } from './mesh';
import { solveStatic, type StaticAnalysis } from './statics';
import type {
  AnalysisMesh,
  AnalysisOptions,
  CascadeResult,
  EditorModel,
  FailureReport,
  MemberSpec,
} from './types';

/**
 * Evaluate the four static failure classes at one proportional load factor.
 * λ_yield = 1/max(U), global buckling is λ_cr,
 * and the member Euler check is π²EI/L_member².
 */
export function evaluateFailure(
  model: EditorModel,
  loadFactor: number,
  options: AnalysisOptions = {},
): FailureReport {
  if (!(loadFactor > 0) || !Number.isFinite(loadFactor))
    throw new Error('Failure evaluation needs a finite positive load factor.');
  const analysis = analyzeAtFactor(model, loadFactor, options);
  if (analysis.kind === 'mechanism') return { kind: 'mechanism', nodeId: analysis.nodeId };
  if (analysis.kind === 'invalid') throw new Error(analysis.message);
  if (analysis.kind === 'divergent') throw new Error(analysis.message);
  if (analysis.kind !== 'stable')
    throw new Error('Failure evaluation needs a stable static solve.');

  const yieldState = governingYield(analysis);
  const memberBuckling = governingMemberBuckling(analysis.mesh, analysis.result.elementForces);
  const globalBuckling = governingGlobalBuckling(analysis.mesh, analysis.result.elementForces);
  if (
    yieldState.utilization >= 1 &&
    yieldState.utilization >= memberBuckling.ratio &&
    yieldState.utilization >= globalBuckling.ratio
  ) {
    return {
      kind: 'yield',
      memberId: yieldState.memberId,
      utilization: yieldState.utilization,
      loadFactor,
      stationM: yieldState.stationM,
    };
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
    return {
      kind: 'buckling',
      governs: 'global',
      memberId: globalBuckling.memberId,
      lambdaCr: globalBuckling.capacityFactor,
    };
  }

  const yieldCapacity = yieldState.utilization > 0 ? loadFactor / yieldState.utilization : Infinity;
  const memberCapacity = memberBuckling.ratio > 0 ? loadFactor / memberBuckling.ratio : Infinity;
  const globalCapacity = globalBuckling.capacityFactor;
  const capacityFactor = Math.min(yieldCapacity, memberCapacity, globalCapacity);
  if (capacityFactor === yieldCapacity)
    return { kind: 'stable', capacityFactor, governedBy: 'yield', memberId: yieldState.memberId };
  return {
    kind: 'stable',
    capacityFactor,
    governedBy: 'buckling',
    memberId: memberCapacity <= globalCapacity ? memberBuckling.memberId : globalBuckling.memberId,
  };
}

/**
 * Deterministic quasi-static collapse: remove buckled/axial members or insert
 * a hinge at the governing bending end, then re-solve at the same load.
 * Maximum twenty steps.
 */
export function collapseCascade(
  model: EditorModel,
  loadFactor = 1,
  options: AnalysisOptions = {},
): CascadeResult {
  if (!(loadFactor > 0) || !Number.isFinite(loadFactor))
    throw new Error('Collapse cascade needs a finite positive load factor.');
  let current = cloneModel(model);
  const steps: CascadeResult['steps'] = [];
  for (let index = 0; index < 20; index++) {
    const report = evaluateFailure(current, loadFactor, options);
    if (report.kind === 'mechanism') return { steps, outcome: 'collapse' };
    if (report.kind === 'stable') return { steps, outcome: 'stable' };
    // Dynamic resonance is reported by the wind story; this quasi-static path
    // deliberately has no inertial collapse step.
    if (report.kind === 'resonance') return { steps, outcome: 'stable' };
    const memberId = report.memberId;
    const member = current.members.find((candidate) => candidate.id === memberId);
    if (!member) return { steps, outcome: 'collapse' };
    const analysis = analyzeAtFactor(current, loadFactor, options);
    if (analysis.kind !== 'stable') return { steps, outcome: 'collapse' };
    const axialDominant = memberAxialDominant(
      analysis.mesh,
      analysis.result.elementForces,
      memberId,
    );
    if (report.kind === 'buckling' || axialDominant) {
      current = removeMember(current, memberId);
      steps.push({
        action: 'remove',
        memberId,
        detail: `Member ${memberId} buckled/was axial-governing and was removed.`,
      });
      continue;
    }
    const releaseAt = governingMomentEnd(analysis.mesh, analysis.result.elementForces, memberId);
    if (releaseAt === 'a' && !member.releaseA) {
      current = patchMember(current, memberId, { releaseA: true });
      steps.push({
        action: 'hinge',
        memberId,
        detail: `Hinge inserted at member ${memberId} end A after bending yield.`,
      });
    } else if (releaseAt === 'b' && !member.releaseB) {
      current = patchMember(current, memberId, { releaseB: true });
      steps.push({
        action: 'hinge',
        memberId,
        detail: `Hinge inserted at member ${memberId} end B after bending yield.`,
      });
    } else {
      current = removeMember(current, memberId);
      steps.push({
        action: 'remove',
        memberId,
        detail: `Member ${memberId} could not take another hinge and was removed.`,
      });
    }
  }
  return { steps, outcome: 'stable' };
}

/** Solve the base load case at a proportional ramp factor. */
export function analyzeAtFactor(
  model: EditorModel,
  factor: number,
  options: AnalysisOptions = {},
): StaticAnalysis {
  if (!(factor > 0) || !Number.isFinite(factor))
    return { kind: 'invalid', message: 'Ramp factor must be finite and positive.' };
  try {
    if (modelHasCables(model)) return solveTensionOnly(model, options, factor).analysis;
    const mesh = buildMesh(model, options);
    const nodeIndex = new Map<number, number>();
    for (let index = 0; index < mesh.editorNode.length; index++) {
      const id = mesh.editorNode[index]!;
      if (id >= 0) nodeIndex.set(id, index);
    }
    const points = model.loads.points.flatMap((point) => {
      const meshNode = nodeIndex.get(point.node);
      return meshNode === undefined ? [] : [{ meshNode, fx: point.fx, fy: point.fy }];
    });
    const base = assembleLoadCase(mesh, { gravity: model.loads.gravity, points });
    return solveStatic(mesh, scaleLoadAssembly(base, factor));
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : 'Ramp analysis could not run.',
    };
  }
}

/** Scale both external loads and retained fixed-end vectors so recovery remains exact. */
function scaleLoadAssembly(loads: LoadAssembly, factor: number): LoadAssembly {
  const F = new Float64Array(loads.F.length);
  const elementFixedEnd = new Float64Array(loads.elementFixedEnd.length);
  const elementTransverseUdl = new Float64Array(loads.elementTransverseUdl.length);
  for (let index = 0; index < F.length; index++) F[index] = loads.F[index]! * factor;
  for (let index = 0; index < elementFixedEnd.length; index++)
    elementFixedEnd[index] = loads.elementFixedEnd[index]! * factor;
  for (let index = 0; index < elementTransverseUdl.length; index++)
    elementTransverseUdl[index] = loads.elementTransverseUdl[index]! * factor;
  return { F, elementFixedEnd, elementTransverseUdl };
}

function governingYield(analysis: Extract<StaticAnalysis, { kind: 'stable' }>): {
  memberId: number;
  utilization: number;
  stationM?: number;
} {
  let memberId = -1;
  let utilization = 0;
  let stationM: number | undefined;
  for (const [id, value] of analysis.result.utilization) {
    if (value > utilization) {
      memberId = id;
      utilization = value;
      stationM = analysis.result.utilizationStationM?.get(id);
    }
  }
  return { memberId, utilization, stationM };
}

/** Per-member Euler comparison |N| / (π²EI/L_member²). */
function governingMemberBuckling(
  mesh: AnalysisMesh,
  forces: Float64Array,
): { memberId: number; ratio: number; N: number; Ncr: number } {
  const lengths = new Map<number, number>();
  const compression = new Map<number, number>();
  const properties = new Map<number, { E: number; I: number }>();
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    lengths.set(element.memberId, (lengths.get(element.memberId) ?? 0) + element.L);
    properties.set(element.memberId, { E: element.E, I: element.I });
    compression.set(
      element.memberId,
      Math.max(compression.get(element.memberId) ?? 0, -forces[index * 5]!),
    );
  }
  let result = { memberId: -1, ratio: 0, N: 0, Ncr: Infinity };
  for (const [memberId, N] of compression) {
    const property = properties.get(memberId)!;
    const length = lengths.get(memberId)!;
    const Ncr = (Math.PI ** 2 * property.E * property.I) / (length * length);
    const ratio = N / Ncr;
    if (ratio > result.ratio) result = { memberId, ratio, N, Ncr };
  }
  return result;
}

function governingGlobalBuckling(
  mesh: AnalysisMesh,
  forces: Float64Array,
): { memberId: number; ratio: number; capacityFactor: number } {
  const N = new Float64Array(mesh.elements.length);
  let hasCompression = false;
  let memberId = -1;
  let greatestCompression = 0;
  for (let index = 0; index < N.length; index++) {
    N[index] = forces[index * 5]!;
    if (N[index]! < 0) {
      hasCompression = true;
      if (-N[index]! > greatestCompression) {
        greatestCompression = -N[index]!;
        memberId = mesh.elements[index]!.memberId;
      }
    }
  }
  if (!hasCompression) return { memberId, ratio: 0, capacityFactor: Infinity };
  const result = buckling(mesh, N);
  const currentFactor = result.values[0] ?? Infinity;
  return {
    memberId,
    ratio: currentFactor === Infinity ? 0 : 1 / currentFactor,
    capacityFactor: currentFactor,
  };
}

function memberAxialDominant(mesh: AnalysisMesh, forces: Float64Array, memberId: number): boolean {
  let axial = 0;
  let combined = 0;
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    if (element.memberId !== memberId) continue;
    const N = Math.abs(forces[index * 5]! / element.A);
    const Ma = Math.abs((forces[index * 5 + 2]! * element.c) / element.I);
    const Mb = Math.abs((forces[index * 5 + 4]! * element.c) / element.I);
    axial = Math.max(axial, N);
    combined = Math.max(combined, N + Ma, N + Mb);
  }
  return combined > 0 && axial / combined >= 0.8;
}

function governingMomentEnd(mesh: AnalysisMesh, forces: Float64Array, memberId: number): 'a' | 'b' {
  let end: 'a' | 'b' = 'a';
  let maximum = -Infinity;
  for (let index = 0; index < mesh.elements.length; index++) {
    if (mesh.elements[index]!.memberId !== memberId) continue;
    const a = Math.abs(forces[index * 5 + 2]!);
    const b = Math.abs(forces[index * 5 + 4]!);
    if (a > maximum) {
      maximum = a;
      end = 'a';
    }
    if (b > maximum) {
      maximum = b;
      end = 'b';
    }
  }
  return end;
}

function cloneModel(model: EditorModel): EditorModel {
  return {
    ...model,
    nodes: model.nodes.map((node) => ({ ...node })),
    members: model.members.map((member) => ({ ...member, section: { ...member.section } })),
    supports: model.supports.map((support) => ({ ...support })),
    loads: { ...model.loads, points: model.loads.points.map((point) => ({ ...point })) },
    deck: [...model.deck],
    story: { ...model.story },
  };
}

function removeMember(model: EditorModel, memberId: number): EditorModel {
  return {
    ...model,
    members: model.members.filter((member) => member.id !== memberId),
    deck: model.deck.filter((id) => id !== memberId),
  };
}

function patchMember(
  model: EditorModel,
  memberId: number,
  patch: Partial<MemberSpec>,
): EditorModel {
  return {
    ...model,
    members: model.members.map((member) =>
      member.id === memberId ? { ...member, ...patch } : member,
    ),
  };
}
