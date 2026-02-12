/**
 * Pure challenge evaluation: steel budget, geometry, traffic capacity, ramp λ.
 * docs/FEM-SPEC.md §14 2G.
 */
import { MATERIALS, sectionProps } from '../fem/materials';
import type { AnalysisOptions, EditorModel, MemberSpec, NodeSpec } from '../fem/types';
import { rampCapacity } from '../stories/ramp';
import { prepareTraffic, trafficYieldWeightAt } from '../stories/traffic';
import type {
  ChallengeCheck,
  ChallengeConstraints,
  ChallengeSpec,
  ChallengeVerdict,
} from './types';

/** Steel mass of every `steel-s355` member (kg). docs/FEM-SPEC.md §14 2G. */
export function steelMassKg(model: EditorModel): number {
  const nodes = nodeMap(model.nodes);
  let mass = 0;
  for (const member of model.members) {
    if (member.material !== 'steel-s355') continue;
    mass += memberMassKg(member, nodes);
  }
  return mass;
}

/** Clear horizontal span between outermost supported nodes (m). docs/FEM-SPEC.md §14 2G. */
export function clearSpanM(model: EditorModel): number {
  const xs = supportedXs(model);
  if (xs.length < 2) return 0;
  return xs[xs.length - 1]! - xs[0]!;
}

/** Vertical extent of the drawn nodes (m). docs/FEM-SPEC.md §14 2G. */
export function structureHeightM(model: EditorModel): number {
  if (model.nodes.length === 0) return 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of model.nodes) {
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
  }
  return maxY - minY;
}

/**
 * True when every support sits on one of the two outermost supported nodes.
 * docs/FEM-SPEC.md §14 2G.
 */
export function abutmentsOnly(model: EditorModel): boolean {
  const xs = supportedXs(model);
  if (xs.length < 2) return false;
  const left = xs[0]!;
  const right = xs[xs.length - 1]!;
  const nodes = nodeMap(model.nodes);
  for (const support of model.supports) {
    const node = nodes.get(support.node);
    if (!node) return false;
    if (node.x !== left && node.x !== right) return false;
  }
  return true;
}

/** Mid-deck traffic yield capacity in kN, or undefined when the deck is missing/invalid. docs/FEM-SPEC.md §14 2G. */
export function midspanTruckCapacitykN(
  model: EditorModel,
  options: AnalysisOptions = {},
): number | undefined {
  if (model.deck.length === 0) return undefined;
  try {
    const scenario = prepareTraffic(model, options);
    return trafficYieldWeightAt(scenario, scenario.length / 2);
  } catch {
    return undefined;
  }
}

/** Evaluate a model against one challenge's constraints. docs/FEM-SPEC.md §14 2G. */
export function evaluateChallenge(
  challenge: ChallengeSpec,
  model: EditorModel,
  options: AnalysisOptions = {},
): ChallengeVerdict {
  const constraints = challenge.constraints;
  const probed = withProbeLoads(model, constraints);
  const steel = steelMassKg(model);
  const span = clearSpanM(model);
  const height = structureHeightM(model);
  const truck =
    constraints.minTruckCapacitykN !== undefined
      ? midspanTruckCapacitykN(model, options)
      : undefined;
  const ramp = constraints.minRampLambda !== undefined ? rampCapacity(probed, options) : undefined;

  const checks: ChallengeCheck[] = [
    check(
      'steel-budget',
      'Steel mass',
      steel <= constraints.maxSteelMassKg,
      formatMass(steel),
      `≤ ${formatMass(constraints.maxSteelMassKg)}`,
    ),
  ];

  if (constraints.minClearSpanM !== undefined) {
    checks.push(
      check(
        'clear-span',
        'Clear span',
        span + 1e-9 >= constraints.minClearSpanM,
        formatLength(span),
        `≥ ${formatLength(constraints.minClearSpanM)}`,
      ),
    );
  }
  if (constraints.minHeightM !== undefined) {
    checks.push(
      check(
        'height',
        'Height',
        height + 1e-9 >= constraints.minHeightM,
        formatLength(height),
        `≥ ${formatLength(constraints.minHeightM)}`,
      ),
    );
  }
  if (constraints.abutmentsOnly) {
    checks.push(
      check(
        'abutments-only',
        'Abutments only',
        abutmentsOnly(model),
        abutmentsOnly(model) ? 'ends only' : 'intermediate support',
        'supports only at span ends',
      ),
    );
  }
  if (constraints.minTruckCapacitykN !== undefined) {
    const ok =
      truck !== undefined &&
      Number.isFinite(truck) &&
      truck + 1e-9 >= constraints.minTruckCapacitykN;
    checks.push(
      check(
        'truck-capacity',
        'Truck capacity',
        ok,
        truck === undefined ? 'no deck / unstable' : `${truck.toFixed(0)} kN`,
        `≥ ${constraints.minTruckCapacitykN} kN at midspan`,
      ),
    );
  }
  if (constraints.minRampLambda !== undefined) {
    const ok =
      ramp !== undefined && Number.isFinite(ramp) && ramp + 1e-9 >= constraints.minRampLambda;
    checks.push(
      check(
        'ramp-lambda',
        'Ramp capacity',
        ok,
        ramp === undefined ? 'unstable / no limit' : `λ ${ramp.toFixed(2)}`,
        `λ ≥ ${constraints.minRampLambda}`,
      ),
    );
  }

  return {
    challengeId: challenge.id,
    passed: checks.every((item) => item.ok),
    checks,
    steelMassKg: steel,
    clearSpanM: span,
    heightM: height,
    truckCapacitykN: truck,
    rampLambda: ramp,
  };
}

function check(
  id: string,
  label: string,
  ok: boolean,
  actual: string,
  required: string,
): ChallengeCheck {
  return { id, label, ok, actual, required };
}

/** Apply the challenge's probe tip load when configured. docs/FEM-SPEC.md §14 2G. */
function withProbeLoads(model: EditorModel, constraints: ChallengeConstraints): EditorModel {
  if (constraints.probeTipLoadN === undefined || model.nodes.length === 0) return model;
  let tip = model.nodes[0]!;
  for (const node of model.nodes) {
    if (node.y > tip.y) tip = node;
  }
  return {
    ...model,
    loads: {
      gravity: model.loads.gravity,
      points: [{ node: tip.id, fx: constraints.probeTipLoadN, fy: 0 }],
    },
    story: { kind: 'ramp' },
  };
}

function memberMassKg(member: MemberSpec, nodes: Map<number, NodeSpec>): number {
  const a = nodes.get(member.a);
  const b = nodes.get(member.b);
  if (!a || !b) return 0;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const { A } = sectionProps(member.section);
  return MATERIALS[member.material].rho * A * length;
}

function supportedXs(model: EditorModel): number[] {
  const nodes = nodeMap(model.nodes);
  const xs: number[] = [];
  for (const support of model.supports) {
    const node = nodes.get(support.node);
    if (node) xs.push(node.x);
  }
  xs.sort((a, b) => a - b);
  return xs;
}

function nodeMap(nodes: readonly NodeSpec[]): Map<number, NodeSpec> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function formatMass(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toFixed(2)} t`;
  return `${kg.toFixed(1)} kg`;
}

function formatLength(m: number): string {
  return `${m.toFixed(2)} m`;
}

/** Re-export for callers that only need the constraints shape. */
export type { ChallengeConstraints };
