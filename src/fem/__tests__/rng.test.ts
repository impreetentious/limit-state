import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../rng';

describe('mulberry32', () => {
  it('keeps the seeded stream bit-stable', () => {
    const random = mulberry32(0x1a2b3c4d);
    expect([random(), random(), random()]).toEqual([
      0.2519546449184418, 0.597925832727924, 0.13079005177132785,
    ]);
  });
});
