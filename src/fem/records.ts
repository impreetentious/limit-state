/**
 * Deterministic ground-acceleration records for the earthquake story.
 * docs/FEM-SPEC.md §14 2C — synthetic pulses plus a classic-style scaled series.
 */
import type { EarthquakeRecordId } from './types';

export interface GroundMotionRecord {
  id: EarthquakeRecordId;
  label: string;
  /** Honesty note shown in the Test console. */
  note: string;
  dt: number;
  /** Ground acceleration ü_g(t) in m/s². */
  accel: Float64Array;
}

/** Catalog of built-in records. docs/FEM-SPEC.md §14 2C. */
export function earthquakeRecords(): GroundMotionRecord[] {
  return [pulseRecord(), chirpRecord(), elCentroScaledRecord()];
}

export function earthquakeRecord(id: EarthquakeRecordId): GroundMotionRecord {
  const found = earthquakeRecords().find((record) => record.id === id);
  if (!found) throw new Error(`Unknown earthquake record ${id}.`);
  return found;
}

/** Sample ü_g at time t with linear hold past the last sample. docs/FEM-SPEC.md §14 2C. */
export function groundAccelAt(record: GroundMotionRecord, time: number): number {
  if (time <= 0) return record.accel[0] ?? 0;
  const index = time / record.dt;
  const lo = Math.floor(index);
  if (lo >= record.accel.length - 1) return record.accel[record.accel.length - 1] ?? 0;
  const frac = index - lo;
  return (1 - frac) * record.accel[lo]! + frac * record.accel[lo + 1]!;
}

/** Short sine-burst pulse (≈ 0.5 Hz carrier, 8 s). */
function pulseRecord(): GroundMotionRecord {
  const dt = 0.01;
  const duration = 8;
  const n = Math.floor(duration / dt) + 1;
  const accel = new Float64Array(n);
  const f = 0.5;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const envelope = Math.sin((Math.PI * t) / duration) ** 2;
    accel[i] = 2.5 * envelope * Math.sin(2 * Math.PI * f * t);
  }
  return {
    id: 'pulse',
    label: 'Pulse (0.5 Hz)',
    note: 'Synthetic sine burst — not a recorded earthquake.',
    dt,
    accel,
  };
}

/** Linear chirp 0.2→4 Hz over 12 s. */
function chirpRecord(): GroundMotionRecord {
  const dt = 0.01;
  const duration = 12;
  const n = Math.floor(duration / dt) + 1;
  const accel = new Float64Array(n);
  const f0 = 0.2;
  const f1 = 4;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const frac = t / duration;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * (f1 - f0) * ((t * t) / duration));
    const envelope = Math.sin(Math.PI * frac) ** 1.5;
    accel[i] = 1.8 * envelope * Math.sin(phase);
  }
  return {
    id: 'chirp',
    label: 'Chirp (0.2–4 Hz)',
    note: 'Synthetic frequency sweep — makes spectral teeth visible.',
    dt,
    accel,
  };
}

/**
 * El Centro–style scaled synthetic: seeded multi-frequency burst with a
 * classic-like envelope. Not the 1940 Imperial Valley recording — labelled so.
 */
function elCentroScaledRecord(): GroundMotionRecord {
  const dt = 0.02;
  const duration = 20;
  const n = Math.floor(duration / dt) + 1;
  const accel = new Float64Array(n);
  let state = 19400518 >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const bands = [
    { f: 0.4, a: 0.9, phase: 2 * Math.PI * random() },
    { f: 0.9, a: 1.4, phase: 2 * Math.PI * random() },
    { f: 1.6, a: 1.1, phase: 2 * Math.PI * random() },
    { f: 2.5, a: 0.7, phase: 2 * Math.PI * random() },
    { f: 4.0, a: 0.35, phase: 2 * Math.PI * random() },
  ];
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const rise = Math.min(1, t / 2);
    const decay = Math.exp(-0.12 * Math.max(0, t - 4));
    const envelope = rise * decay;
    let value = 0;
    for (const band of bands) value += band.a * Math.sin(2 * Math.PI * band.f * t + band.phase);
    value += 0.25 * (random() - 0.5);
    accel[i] = envelope * value;
  }
  let peak = 0;
  for (const sample of accel) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0) {
    const scale = (0.35 * 9.80665) / peak;
    for (let i = 0; i < accel.length; i++) accel[i] = accel[i]! * scale;
  }
  return {
    id: 'elcentro-scaled',
    label: 'El Centro–style (scaled)',
    note: 'Synthetic classic-style record scaled to 0.35 g peak — not the 1940 Imperial Valley file.',
    dt,
    accel,
  };
}
