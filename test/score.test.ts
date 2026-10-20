import { describe, expect, it } from 'vitest';
import { buildProfileFromSamples } from '../src/gpx/profile';
import {
  DEFAULT_WEIGHTS,
  MIX_ROAD,
  emd,
  scoreCourse,
  surfaceMismatch,
  type AssembledCourse,
} from '../src/search/score';

function triangle(n: number, peak: number): Float32Array {
  const out = new Float32Array(n);
  const half = (n - 1) / 2;
  for (let i = 0; i < n; i++) out[i] = peak * (1 - Math.abs(i - half) / half);
  return out;
}

function courseFrom(samples: Float32Array, reachRatio = 0.5): AssembledCourse {
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]! - samples[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  return {
    samples,
    lengthM: (samples.length - 1) * 25,
    gain,
    loss,
    surfaceSplit: [1, 0, 0, 0],
    penaltyFraction: 0,
    repeatFraction: 0,
    oscillationFraction: 0,
    untrackedFraction: 0,
    reachM: (samples.length - 1) * 25 * reachRatio,
    turnsPerKm: 0,
    denseTurnsPerKm: 0,
    signalsPerKm: 0,
  };
}

describe('scoreCourse', () => {
  const target = buildProfileFromSamples(triangle(801, 100), 800 * 25);

  it('identical profile scores 0', () => {
    expect(scoreCourse(courseFrom(triangle(801, 100)), target)).toBeCloseTo(0, 5);
  });

  it('flat vs flat scores 0', () => {
    const flatTarget = buildProfileFromSamples(new Float32Array(801), 800 * 25);
    expect(scoreCourse(courseFrom(new Float32Array(801)), flatTarget)).toBe(0);
  });

  it('a 100 m shift scores small, the mirror scores large', () => {
    const shifted = new Float32Array(801);
    const tri = triangle(801, 100);
    for (let i = 0; i < 801; i++) shifted[i] = tri[Math.max(0, i - 4)]!;
    const mirror = new Float32Array(801);
    for (let i = 0; i < 801; i++) mirror[i] = -tri[i]!;

    const shiftScore = scoreCourse(courseFrom(shifted), target);
    const mirrorScore = scoreCourse(courseFrom(mirror), target);
    expect(shiftScore).toBeGreaterThan(0);
    expect(shiftScore).toBeLessThan(10);
    expect(mirrorScore).toBeGreaterThan(5 * shiftScore);
  });

  it('penalty, repeat and oscillation terms add to the score', () => {
    const clean = courseFrom(triangle(801, 100));
    const dirty = { ...clean, penaltyFraction: 0.2, repeatFraction: 0.5, oscillationFraction: 0.1 };
    expect(scoreCourse(dirty, target)).toBeCloseTo(
      DEFAULT_WEIGHTS.penalty * 0.2 +
        DEFAULT_WEIGHTS.repeat * 0.5 +
        DEFAULT_WEIGHTS.oscillation * 0.1,
      3,
    );
  });

  it('oscillation outweighs the same amount of far repeat', () => {
    const clean = courseFrom(triangle(801, 100));
    const laps = { ...clean, repeatFraction: 0.3 };
    const bounce = { ...clean, oscillationFraction: 0.3 };
    expect(scoreCourse(bounce, target)).toBeGreaterThan(2 * scoreCourse(laps, target));
  });

  it('a course going nowhere is punished however well its profile fits', () => {
    // 20 km of laps that never get 200 m from the start, against 20 km of
    // running: identical profiles, so only the ground covered separates them.
    const circles = courseFrom(triangle(801, 100), 0.01);
    const sprawling = courseFrom(triangle(801, 100));
    expect(scoreCourse(sprawling, target)).toBeCloseTo(0, 5);
    expect(scoreCourse(circles, target)).toBeGreaterThan(0.8 * DEFAULT_WEIGHTS.confinement);

    // A loop reaching a sixth of its length away is fine, penalty-free.
    expect(scoreCourse(courseFrom(triangle(801, 100), 1 / 6), target)).toBeCloseTo(0, 5);
  });

  it('surface mismatch penalises a trail course against a road mix', () => {
    const trail = { ...courseFrom(triangle(801, 100)), surfaceSplit: [0, 0, 1, 0] as [number, number, number, number] };
    expect(scoreCourse(trail, target, MIX_ROAD)).toBeCloseTo(DEFAULT_WEIGHTS.surface, 3);
  });
});

describe('windowShapeError', () => {
  it('is 0 for identical profiles and insensitive to a constant offset', async () => {
    const { windowShapeError } = await import('../src/search/score');
    const tri = triangle(801, 100);
    expect(windowShapeError(tri, tri)).toBe(0);
    const offset = new Float32Array(801);
    for (let i = 0; i < 801; i++) offset[i] = tri[i]! + 15;
    expect(windowShapeError(offset, tri)).toBeLessThan(0.01);
  });

  it('catches a short spike against a flat target', async () => {
    const { windowShapeError } = await import('../src/search/score');
    const flat = new Float32Array(801);
    const spiky = new Float32Array(801);
    for (let i = 450; i < 460; i++) spiky[i] = 20; // ~250 m spike of 20 m
    // The same gain spread over the whole course is a far smaller local error.
    const gentle = new Float32Array(801);
    for (let i = 0; i < 801; i++) gentle[i] = (i / 800) * 20;
    expect(windowShapeError(spiky, flat)).toBeGreaterThan(5 * windowShapeError(gentle, flat));
  });

  it('charges a sawtooth for every bump, not just its worst one', async () => {
    const { windowShapeError } = await import('../src/search/score');
    // The race: one steady 100 m climb over 20 km.
    const climb = triangle(801, 0);
    for (let i = 0; i < 801; i++) climb[i] = (i / 800) * 100;

    // Same start, same finish, same total gain — but taken as 20 bumps.
    const sawtooth = new Float32Array(801);
    for (let i = 0; i < 801; i++) {
      sawtooth[i] = climb[i]! + 12 * Math.sin((i / 800) * 20 * 2 * Math.PI);
    }
    // The same wobble in one place only, which a worst-window term would have
    // scored identically — that is the behaviour this term exists to fix.
    const oneBump = new Float32Array(climb);
    for (let i = 380; i < 420; i++) {
      oneBump[i] = climb[i]! + 12 * Math.sin(((i - 380) / 40) * 2 * Math.PI);
    }
    expect(windowShapeError(sawtooth, climb)).toBeGreaterThan(
      3 * windowShapeError(oneBump, climb),
    );
  });
});

describe('emd', () => {
  it('is 0 for identical histograms', () => {
    const h = new Float32Array([0.25, 0.5, 0.25]);
    expect(emd(h, h)).toBe(0);
  });

  it('grows with distance moved', () => {
    const near = emd(new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0]));
    const far = emd(new Float32Array([1, 0, 0]), new Float32Array([0, 0, 1]));
    expect(far).toBeGreaterThan(near);
  });
});

describe('surfaceMismatch', () => {
  it('is 0 for a perfect match and 1 for paved vs trail', () => {
    expect(surfaceMismatch([1, 0, 0, 0], [1, 0, 0, 0])).toBe(0);
    expect(surfaceMismatch([0, 0, 1, 0], [1, 0, 0, 0])).toBe(1);
  });

  it('paved and gravel are near-equivalent', () => {
    expect(surfaceMismatch([0, 1, 0, 0], [1, 0, 0, 0])).toBeCloseTo(0.1);
    expect(surfaceMismatch([0.5, 0.5, 0, 0], [1, 0, 0, 0])).toBeCloseTo(0.05);
  });

  it('gravel is closer to trail than paved is', () => {
    const gravelOnTrail = surfaceMismatch([0, 1, 0, 0], [0, 0, 1, 0]);
    const pavedOnTrail = surfaceMismatch([1, 0, 0, 0], [0, 0, 1, 0]);
    expect(gravelOnTrail).toBeLessThan(pavedOnTrail);
  });

  it('a null mix ("any") disables the surface term', () => {
    const target = buildProfileFromSamples(triangle(801, 100), 800 * 25);
    const trail = {
      ...courseFrom(triangle(801, 100)),
      surfaceSplit: [0, 0, 1, 0] as [number, number, number, number],
    };
    expect(scoreCourse(trail, target, null)).toBeCloseTo(0, 5);
  });
});
