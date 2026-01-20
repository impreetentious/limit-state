/**
 * SDOF response-spectrum helpers for the earthquake story.
 * Sweep 0.1–10 Hz; gate vs Newmark SDOF peak.
 */
import type { GroundMotionRecord } from './records';

export interface SpectrumPoint {
  freqHz: number;
  /** Pseudo-acceleration Sa = ω² · max|u| (m/s²). */
  sa: number;
  /** Peak relative displacement (m). */
  sd: number;
}

export interface ResponseSpectrum {
  zeta: number;
  points: SpectrumPoint[];
  /** Index of the maximum Sa point. */
  peakIndex: number;
}

/**
 * Average-acceleration Newmark on ü + 2ζωú + ω²u = −üg(t).
 * Returns relative displacement history.
 */
export function newmarkSdofRelative(
  omega: number,
  zeta: number,
  ugDdot: Float64Array,
  dt: number,
): Float64Array {
  if (!(omega > 0) || !Number.isFinite(omega)) throw new Error('SDOF ω must be finite and positive.');
  if (!(zeta >= 0) || !Number.isFinite(zeta)) throw new Error('SDOF ζ must be finite and non-negative.');
  if (!(dt > 0) || !Number.isFinite(dt)) throw new Error('SDOF Δt must be finite and positive.');
  const u = new Float64Array(ugDdot.length);
  let disp = 0;
  let vel = 0;
  let acc = ugDdot.length > 0 ? -ugDdot[0]! : 0;
  const beta = 0.25;
  const gamma = 0.5;
  const a0 = 1 / (beta * dt * dt);
  const a1 = gamma / (beta * dt);
  const a2 = 1 / (beta * dt);
  const a3 = 1 / (2 * beta) - 1;
  const a4 = gamma / beta - 1;
  const a5 = dt * (gamma / (2 * beta) - 1);
  const k = omega * omega;
  const c = 2 * zeta * omega;
  const khat = k + a0 + a1 * c;
  u[0] = 0;
  for (let i = 1; i < ugDdot.length; i++) {
    const p = -ugDdot[i]!;
    const effective = p + a0 * disp + a2 * vel + a3 * acc + c * (a1 * disp + a4 * vel + a5 * acc);
    const next = effective / khat;
    const nextAcc = a0 * (next - disp) - a2 * vel - a3 * acc;
    const nextVel = vel + dt * ((1 - gamma) * acc + gamma * nextAcc);
    disp = next;
    vel = nextVel;
    acc = nextAcc;
    u[i] = disp;
  }
  return u;
}

/** Peak |u| of an SDOF Newmark run. */
export function peakAbs(values: Float64Array): number {
  let peak = 0;
  for (const value of values) peak = Math.max(peak, Math.abs(value));
  return peak;
}

/**
 * Pseudo-acceleration spectrum Sa(f) over a frequency grid.
 */
export function responseSpectrum(
  record: GroundMotionRecord,
  zeta: number,
  freqHz: readonly number[] = spectrumFrequencies(),
): ResponseSpectrum {
  const points: SpectrumPoint[] = [];
  let peakIndex = 0;
  let peakSa = -Infinity;
  for (let index = 0; index < freqHz.length; index++) {
    const f = freqHz[index]!;
    const omega = 2 * Math.PI * f;
    const u = newmarkSdofRelative(omega, zeta, record.accel, record.dt);
    const sd = peakAbs(u);
    const sa = omega * omega * sd;
    points.push({ freqHz: f, sa, sd });
    if (sa > peakSa) {
      peakSa = sa;
      peakIndex = index;
    }
  }
  return { zeta, points, peakIndex };
}

/** Default log-spaced sweep 0.1–10 Hz (81 points). */
export function spectrumFrequencies(minHz = 0.1, maxHz = 10, count = 81): number[] {
  if (!(minHz > 0) || !(maxHz > minHz) || !(count >= 2)) throw new Error('Invalid spectrum frequency grid.');
  const out: number[] = [];
  const logMin = Math.log(minHz);
  const logMax = Math.log(maxHz);
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    out.push(Math.exp(logMin + t * (logMax - logMin)));
  }
  return out;
}
