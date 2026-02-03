/** Material and section presets. Values are the product spec. */
import type { Material, MaterialId, SectionProps, SectionSpec } from './types';

export const MATERIALS: Record<MaterialId, Material> = {
  // G = E / (2(1+ν)). Steel/alu/spaghetti use isotropic ν; timber uses a softwood G∥ ≈ E/16.
  'steel-s355': {
    id: 'steel-s355',
    label: 'Steel S355',
    E: 200e9,
    G: 200e9 / 2.6,
    fy: 355e6,
    rho: 7850,
  },
  'alu-6061': {
    id: 'alu-6061',
    label: 'Aluminum 6061-T6',
    E: 69e9,
    G: 69e9 / (2 * 1.33),
    fy: 276e6,
    rho: 2700,
  },
  timber: { id: 'timber', label: 'Timber (softwood)', E: 11e9, G: 11e9 / 16, fy: 40e6, rho: 500 },
  spaghetti: {
    id: 'spaghetti',
    label: 'Spaghetti (dry)',
    E: 3.8e9,
    G: 3.8e9 / 2.6,
    fy: 20e6,
    rho: 1500,
  },
};

export const DEFAULT_SECTION: SectionSpec = { kind: 'box', b: 0.2, h: 0.2, t: 0.008 };

/**
 * St. Venant torsion constant for a solid rectangle.
 * Roark / Timoshenko series approx: J = β b h³ with β from the aspect ratio.
 */
function solidRectJ(b: number, h: number): number {
  const long = Math.max(b, h);
  const short = Math.min(b, h);
  const a = short / long;
  // β ≈ (1/3)(1 − 0.63 a + 0.052 a⁵) for the short³·long form.
  const beta = (1 / 3) * (1 - 0.63 * a * (1 - (a * a * a * a) / 12));
  return beta * long * short ** 3;
}

/**
 * Thin-walled closed-box torsion: J = 4 A_m² / ∮ ds/t.
 * Mid-line enclosed area A_m = (b−t)(h−t); perimeter integral ≈ 2((b−t)+(h−t))/t.
 */
function thinBoxJ(b: number, h: number, t: number): number {
  const bm = b - t;
  const hm = h - t;
  if (!(bm > 0 && hm > 0 && t > 0)) return solidRectJ(b, h);
  const Am = bm * hm;
  const oint = (2 * (bm + hm)) / t;
  return (4 * Am * Am) / oint;
}

/**
 * Open I-section St. Venant approx: sum of thin rectangles (⅓ b t³ each).
 * Warping torsion is out of scope.
 */
function ibeamJ(b: number, h: number, tf: number, tw: number): number {
  const web = Math.max(0, h - 2 * tf);
  return (1 / 3) * (2 * b * tf ** 3 + web * tw ** 3);
}

/** A, I≡Iz, Iy, Iz, c, As, J from section dimensions. Unit-tested (gate G10). */
export function sectionProps(s: SectionSpec): SectionProps {
  switch (s.kind) {
    case 'rect': {
      const A = s.b * s.h;
      const Iz = (s.b * s.h ** 3) / 12;
      const Iy = (s.h * s.b ** 3) / 12;
      return { A, I: Iz, Iy, Iz, c: s.h / 2, As: (5 / 6) * A, J: solidRectJ(s.b, s.h) };
    }
    case 'box': {
      const bi = s.b - 2 * s.t;
      const hi = s.h - 2 * s.t;
      const A = s.b * s.h - bi * hi;
      const Iz = (s.b * s.h ** 3 - bi * hi ** 3) / 12;
      const Iy = (s.h * s.b ** 3 - hi * bi ** 3) / 12;
      // Thin-walled box: shear carried by the two webs (I-web-only analogue).
      return {
        A,
        I: Iz,
        Iy,
        Iz,
        c: s.h / 2,
        As: 2 * hi * s.t,
        J: thinBoxJ(s.b, s.h, s.t),
      };
    }
    case 'ibeam': {
      const web = s.h - 2 * s.tf;
      const A = 2 * s.b * s.tf + s.tw * web;
      const Iz = (s.b * s.h ** 3) / 12 - ((s.b - s.tw) * web ** 3) / 12;
      // About local y: flanges as rectangles at depth, web as thin strip.
      const Iy = 2 * ((s.tf * s.b ** 3) / 12) + (web * s.tw ** 3) / 12;
      // I-web-only shear area.
      return { A, I: Iz, Iy, Iz, c: s.h / 2, As: s.tw * web, J: ibeamJ(s.b, s.h, s.tf, s.tw) };
    }
    case 'tube': {
      const di = s.d - 2 * s.t;
      const A = (Math.PI / 4) * (s.d ** 2 - di ** 2);
      const I = (Math.PI / 64) * (s.d ** 4 - di ** 4);
      // Circular tube: polar J = Iy + Iz = 2I.
      return {
        A,
        I,
        Iy: I,
        Iz: I,
        c: s.d / 2,
        As: 0.5 * A,
        J: 2 * I,
      };
    }
  }
}

/** Depth used for the stocky-member L/h note. */
export function sectionDepth(s: SectionSpec): number {
  switch (s.kind) {
    case 'rect':
    case 'box':
    case 'ibeam':
      return s.h;
    case 'tube':
      return s.d;
  }
}

/**
 * Plastic section modulus Z (first moment of area about the plastic NA).
 * M_p = Z · f_y.
 */
export function plasticModulus(s: SectionSpec): number {
  switch (s.kind) {
    case 'rect':
      return (s.b * s.h * s.h) / 4;
    case 'box': {
      const bi = s.b - 2 * s.t;
      const hi = s.h - 2 * s.t;
      return (s.b * s.h * s.h - bi * hi * hi) / 4;
    }
    case 'ibeam': {
      // Flanges fully plastic + web contribution about mid-depth.
      const web = s.h - 2 * s.tf;
      return s.b * s.tf * (s.h - s.tf) + (s.tw * web * web) / 4;
    }
    case 'tube': {
      const di = s.d - 2 * s.t;
      return (s.d ** 3 - di ** 3) / 6;
    }
  }
}

/** Plastic moment capacity M_p = Z · f_y. */
export function plasticMoment(s: SectionSpec, fy: number): number {
  return plasticModulus(s) * fy;
}
