/** Material and section presets. Values are the product spec. */
import type { Material, MaterialId, SectionProps, SectionSpec } from './types';

export const MATERIALS: Record<MaterialId, Material> = {
  'steel-s355': { id: 'steel-s355', label: 'Steel S355', E: 200e9, fy: 355e6, rho: 7850 },
  'alu-6061': { id: 'alu-6061', label: 'Aluminum 6061-T6', E: 69e9, fy: 276e6, rho: 2700 },
  timber: { id: 'timber', label: 'Timber (softwood)', E: 11e9, fy: 40e6, rho: 500 },
  spaghetti: { id: 'spaghetti', label: 'Spaghetti (dry)', E: 3.8e9, fy: 20e6, rho: 1500 },
};

export const DEFAULT_SECTION: SectionSpec = { kind: 'box', b: 0.2, h: 0.2, t: 0.008 };

/** A, I, c from section dimensions. Unit-tested against hand calcs (gate G10). */
export function sectionProps(s: SectionSpec): SectionProps {
  switch (s.kind) {
    case 'rect': {
      return { A: s.b * s.h, I: (s.b * s.h ** 3) / 12, c: s.h / 2 };
    }
    case 'box': {
      const bi = s.b - 2 * s.t;
      const hi = s.h - 2 * s.t;
      return {
        A: s.b * s.h - bi * hi,
        I: (s.b * s.h ** 3 - bi * hi ** 3) / 12,
        c: s.h / 2,
      };
    }
    case 'ibeam': {
      const web = s.h - 2 * s.tf;
      const A = 2 * s.b * s.tf + s.tw * web;
      const I =
        (s.b * s.h ** 3) / 12 - ((s.b - s.tw) * web ** 3) / 12;
      return { A, I, c: s.h / 2 };
    }
    case 'tube': {
      const di = s.d - 2 * s.t;
      return {
        A: (Math.PI / 4) * (s.d ** 2 - di ** 2),
        I: (Math.PI / 64) * (s.d ** 4 - di ** 4),
        c: s.d / 2,
      };
    }
  }
}
