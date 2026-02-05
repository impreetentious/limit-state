/**
 * Workplane frames for the 3D editor — presets + custom.
 */
import type { Vec3 } from './ops3d';
import { scaleVec } from './ops3d';

/** Right-handed draw frame: u×v = n (extrude direction). */
export interface WorkplaneFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
}

export type WorkplaneKind = 'ground' | 'xz' | 'yz' | 'custom';

export type WorkplaneSpec =
  | { kind: 'ground' | 'xz' | 'yz' }
  | { kind: 'custom'; frame: WorkplaneFrame };

export function presetFrame(kind: 'ground' | 'xz' | 'yz'): WorkplaneFrame {
  switch (kind) {
    case 'ground':
      return {
        origin: { x: 0, y: 0, z: 0 },
        u: { x: 1, y: 0, z: 0 },
        v: { x: 0, y: 1, z: 0 },
        n: { x: 0, y: 0, z: 1 },
      };
    case 'xz':
      return {
        origin: { x: 0, y: 0, z: 0 },
        u: { x: 1, y: 0, z: 0 },
        v: { x: 0, y: 0, z: 1 },
        n: { x: 0, y: 1, z: 0 },
      };
    case 'yz':
      return {
        origin: { x: 0, y: 0, z: 0 },
        u: { x: 0, y: 1, z: 0 },
        v: { x: 0, y: 0, z: 1 },
        n: { x: 1, y: 0, z: 0 },
      };
  }
}

export function resolveWorkplaneFrame(spec: WorkplaneSpec): WorkplaneFrame {
  return spec.kind === 'custom' ? spec.frame : presetFrame(spec.kind);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function norm(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function unit(v: Vec3): Vec3 | undefined {
  const L = norm(v);
  if (!(L > 1e-12)) return undefined;
  return { x: v.x / L, y: v.y / L, z: v.z / L };
}

/** Closest point on the plane. */
export function projectPointToFrame(p: Vec3, frame: WorkplaneFrame): Vec3 {
  const rel = sub(p, frame.origin);
  return sub(p, scaleVec(frame.n, dot(rel, frame.n)));
}

export function frameExtrudeAxis(frame: WorkplaneFrame): Vec3 {
  return frame.n;
}

/**
 * Build a frame from three non-collinear points (origin, u-direction, v hint).
 */
export function frameFromThreePoints(
  origin: Vec3,
  alongU: Vec3,
  alongV: Vec3,
): WorkplaneFrame | undefined {
  const u = unit(sub(alongU, origin));
  if (!u) return undefined;
  const rawV = sub(alongV, origin);
  const n = unit(cross(u, rawV));
  if (!n) return undefined;
  const v = unit(cross(n, u));
  if (!v) return undefined;
  return { origin: { ...origin }, u, v, n };
}

/**
 * Point + normal: complete a right-handed triad (prefer global Z, else Y — same as memberTriad).
 */
export function frameFromPointNormal(origin: Vec3, normal: Vec3): WorkplaneFrame | undefined {
  const n = unit(normal);
  if (!n) return undefined;
  const ref =
    Math.abs(dot(n, { x: 0, y: 0, z: 1 })) > 0.9 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  const u = unit(cross(ref, n));
  if (!u) return undefined;
  const v = unit(cross(n, u));
  if (!v) return undefined;
  return { origin: { ...origin }, u, v, n };
}

/** Snap a world point onto the plane then optionally grid-snap in (u,v). */
export function snapOnFrame(p: Vec3, frame: WorkplaneFrame, gridSnap: boolean): Vec3 {
  const onPlane = projectPointToFrame(p, frame);
  if (!gridSnap) return onPlane;
  const rel = sub(onPlane, frame.origin);
  let su = dot(rel, frame.u);
  let sv = dot(rel, frame.v);
  su = Math.round(su * 2) / 2;
  sv = Math.round(sv * 2) / 2;
  return add(frame.origin, add(scaleVec(frame.u, su), scaleVec(frame.v, sv)));
}
