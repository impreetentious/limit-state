import type { StaticAnalysis } from '../fem/statics';
import type { MemberSpec } from '../fem/types';
import type { ResultDiagram } from '../state/editor-store';

export interface Point {
  x: number;
  y: number;
}

/**
 * docs/FEM-SPEC.md §6.8 — ordinate sampling for the classic A/S/M diagrams.
 *
 * Kept separate from the canvas so it stays pure and testable: the drawing code
 * only maps these model-space ordinates through `toScreen`. Sampling at
 * interior stations is the whole point of the feature — a single per-member
 * extreme renders a UDL moment as a flat block and a shear that never crosses
 * zero, which is exactly the pedagogy the diagrams exist for.
 */
export interface DiagramSample {
  /** Model-space position along the member. */
  point: Point;
  /** Ordinate value at that station: N, V, or M. */
  value: number;
}

export interface DiagramSampling {
  /** Samples per member id, ordered from the member's A node to its B node. */
  byMember: Map<number, DiagramSample[]>;
  /** Largest absolute ordinate across every member, floored at 1 for scaling. */
  maximum: number;
}

/** Interior stations per mesh element. 12 resolves a parabola cleanly. */
export const DIAGRAM_STATIONS = 12;

export function sampleDiagram(
  members: readonly MemberSpec[],
  analysis: Extract<StaticAnalysis, { kind: 'stable' }>,
  diagram: Exclude<ResultDiagram, 'none'>,
): DiagramSampling {
  const byMember = new Map<number, DiagramSample[]>();
  let maximum = 1;

  for (const member of members) {
    const relevant = analysis.mesh.elements.flatMap((element, index) =>
      element.memberId === member.id ? [index] : [],
    );
    const samples: DiagramSample[] = [];

    for (const index of relevant) {
      const offset = index * 5;
      const element = analysis.mesh.elements[index]!;
      const a = {
        x: analysis.mesh.coords[2 * element.na]!,
        y: analysis.mesh.coords[2 * element.na + 1]!,
      };
      const b = {
        x: analysis.mesh.coords[2 * element.nb]!,
        y: analysis.mesh.coords[2 * element.nb + 1]!,
      };
      // Recovery publishes local element-end actions. The diagram convention is
      // V(0)=+Fy1, V(L)=-Fy2, M(0)=-M1, M(L)=+M2 (§6.8).
      const va = analysis.result.elementForces[offset + 1]!;
      const vb = -analysis.result.elementForces[offset + 3]!;
      const ma = -analysis.result.elementForces[offset + 2]!;
      const mb = analysis.result.elementForces[offset + 4]!;

      for (let step = 0; step <= DIAGRAM_STATIONS; step++) {
        // Adjacent elements share a station; keep one copy so the polygon does
        // not double back on itself at the joint.
        if (samples.length > 0 && step === 0) continue;
        const t = step / DIAGRAM_STATIONS;
        const value =
          diagram === 'axial'
            ? analysis.result.elementForces[offset]!
            : diagram === 'shear'
              ? va + (vb - va) * t
              : // Hermite recovery: end moments interpolated linearly plus the
                // parabolic term the transverse load contributes in span.
                ma * (1 - t) + mb * t + ((va - vb) * element.L * t * (1 - t)) / 2;
        samples.push({
          point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
          value,
        });
        maximum = Math.max(maximum, Math.abs(value));
      }
    }

    byMember.set(member.id, samples);
  }

  return { byMember, maximum };
}
