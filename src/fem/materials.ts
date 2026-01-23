/** Material and section presets. Values are the product spec. */
import type { Material, MaterialId, SectionProps, SectionSpec } from './types';

export const MATERIALS: Record<MaterialId, Material> = {
  // G = E / (2(1+ν)). Steel/alu/spaghetti use isotropic ν; timber uses a softwood G∥ ≈ E/16.
  'steel-s355': { id: 'steel-s355', label: 'Steel S355', E: 200e9, G: 200e9 / 2.6, fy: 355e6, rho: 7850 },
  'alu-6061': { id: 'alu-6061', label: 'Aluminum 6061-T6', E: 69e9, G: 69e9 / (2 * 1.33), fy: 276e6, rho: 2700 },
  timber: { id: 'timber', label: 'Timber (softwood)', E: 11e9, G: 11e9 / 16, fy: 40e6, rho: 500 },
  spaghetti: { id: 'spaghetti', label: 'Spaghetti (dry)', E: 3.8e9, G: 3.8e9 / 2.6, fy: 20e6, rho: 1500 },
};

export const DEFAULT_SECTION: SectionSpec = { kind: 'box', b: 0.2, h: 0.2, t: 0.008 };

/** A, I, c, As from section dimensions. Unit-tested against hand calcs (gate G10). */
export function sectionProps(s: SectionSpec): SectionProps {
  switch (s.kind) {
    case 'rect': {
      const A = s.b * s.h;
      return { A, I: (s.b * s.h ** 3) / 12, c: s.h / 2, As: (5 / 6) * A };
    }
    case 'box': {
      const bi = s.b - 2 * s.t;
      const hi = s.h - 2 * s.t;
      const A = s.b * s.h - bi * hi;
      // Thin-walled box: shear carried by the two webs (I-web-only analogue).
      return {
        A,
        I: (s.b * s.h ** 3 - bi * hi ** 3) / 12,
        c: s.h / 2,
        As: 2 * hi * s.t,
      };
    }
    case 'ibeam': {
      const web = s.h - 2 * s.tf;
      const A = 2 * s.b * s.tf + s.tw * web;
      const I = (s.b * s.h ** 3) / 12 - ((s.b - s.tw) * web ** 3) / 12;
      // I-web-only shear area.
      return { A, I, c: s.h / 2, As: s.tw * web };
    }
    case 'tube': {
      const di = s.d - 2 * s.t;
      const A = (Math.PI / 4) * (s.d ** 2 - di ** 2);
      return {
        A,
        I: (Math.PI / 64) * (s.d ** 4 - di ** 4),
        c: s.d / 2,
        As: 0.5 * A,
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
