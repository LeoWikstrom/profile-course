import { SAMPLE_STEP_M } from '../gpx/profile';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The found course draws in the accent; the race it chases in grey. */
const COURSE_COLOR = '#c63d80';

/** Drives the crosshair from outside, for a cursor that is over the map. */
export interface ChartHandle {
  showSample(sampleIndex: number): void;
  hideSample(): void;
}

/**
 * Overlaid target/course chart where touching or dragging shows a crosshair
 * with distance, elevation and grade, and reports the sample index so the
 * matching point can be highlighted on the map. `course` may be null, which
 * leaves the race profile alone but still scrubbable. `onCommit` makes the
 * chart a picker: scrub to a distance, let go, and that sample is chosen.
 * The returned handle points the crosshair at a sample without reporting it
 * back, so hovering the map can show the same point here.
 */
export function renderInteractiveChart(
  container: HTMLElement,
  target: Float32Array,
  course: Float32Array | null,
  onPoint: (sampleIndex: number | null) => void,
  onCommit?: ((sampleIndex: number) => void) | null,
  width = 360,
  height = 140,
): ChartHandle {
  container.textContent = '';

  let min = Infinity;
  let max = -Infinity;
  for (const s of course ? [target, course] : [target]) {
    for (const v of s) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (max - min < 10) max = min + 10;
  const maxDist = (Math.max(target.length, course?.length ?? 0) - 1) * SAMPLE_STEP_M;

  const pad = 4;
  const padTop = 32; // room for the two crosshair label lines
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Elevation profiles of race and course');
  svg.style.touchAction = 'none';

  const x = (i: number) => pad + ((i * SAMPLE_STEP_M) / maxDist) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((v - min) / (max - min)) * (height - pad - padTop);

  const RACE_ONLY_COLOR = '#c63d80';
  for (const { samples, color } of course
    ? [
        { samples: target, color: '#9ca3af' },
        { samples: course, color: COURSE_COLOR },
      ]
    : [{ samples: target, color: RACE_ONLY_COLOR }]) {
    const pts: string[] = [];
    for (let i = 0; i < samples.length; i++) {
      pts.push(`${x(i).toFixed(1)},${y(samples[i]!).toFixed(1)}`);
    }
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1.5');
    svg.appendChild(line);
  }

  const crosshair = document.createElementNS(SVG_NS, 'line');
  crosshair.setAttribute('stroke', 'currentColor');
  crosshair.setAttribute('stroke-dasharray', '3 3');
  crosshair.setAttribute('visibility', 'hidden');
  svg.appendChild(crosshair);

  const TARGET_COLOR = '#9ca3af';

  function makeDot(fill: string): SVGCircleElement {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('r', '4');
    c.setAttribute('fill', fill);
    c.setAttribute('stroke', '#fff');
    c.setAttribute('visibility', 'hidden');
    svg.appendChild(c);
    return c;
  }
  const targetDot = makeDot(course ? TARGET_COLOR : RACE_ONLY_COLOR);
  const dot = makeDot(COURSE_COLOR);

  function makeText(fill: string, y: number): SVGTextElement {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('font-size', '11');
    t.setAttribute('fill', fill);
    t.setAttribute('y', String(y));
    t.setAttribute('visibility', 'hidden');
    svg.appendChild(t);
    return t;
  }
  const text = makeText(COURSE_COLOR, 12);
  const targetText = makeText(course ? TARGET_COLOR : RACE_ONLY_COLOR, course ? 25 : 12);

  function gradeAt(samples: Float32Array, i: number): number {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(samples.length - 1, i + 1);
    if (i1 === i0) return 0;
    return ((samples[i1]! - samples[i0]!) / ((i1 - i0) * SAMPLE_STEP_M)) * 100;
  }

  const shown = course
    ? [crosshair, dot, text, targetDot, targetText]
    : [crosshair, targetDot, targetText];

  /** The sample under the finger, for `onCommit` to take on release. */
  let at: number | null = null;

  function draw(sampleIndex: number): number {
    const i = Math.max(0, Math.min(sampleIndex, (course ?? target).length - 1));
    const cx = x(i);
    crosshair.setAttribute('x1', String(cx));
    crosshair.setAttribute('x2', String(cx));
    crosshair.setAttribute('y1', String(padTop));
    crosshair.setAttribute('y2', String(height - pad));

    const anchorEnd = cx > width / 2;
    const anchor = anchorEnd ? 'end' : 'start';
    const tx = String(anchorEnd ? cx - 6 : cx + 6);
    const km = ((i * SAMPLE_STEP_M) / 1000).toFixed(2);

    if (course) {
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', String(y(course[i]!)));
      text.textContent = `${km} km · ${course[i]!.toFixed(0)} m · ${gradeAt(course, i).toFixed(1)} %`;
      text.setAttribute('text-anchor', anchor);
      text.setAttribute('x', tx);
    }

    const ti = Math.min(i, target.length - 1);
    targetDot.setAttribute('cx', String(x(ti)));
    targetDot.setAttribute('cy', String(y(target[ti]!)));
    targetText.textContent = course
      ? `race: ${target[ti]!.toFixed(0)} m · ${gradeAt(target, ti).toFixed(1)} %`
      : `${km} km · ${target[ti]!.toFixed(0)} m · ${gradeAt(target, ti).toFixed(1)} %`;
    targetText.setAttribute('text-anchor', anchor);
    targetText.setAttribute('x', tx);

    for (const el of shown) el.setAttribute('visibility', 'visible');
    return i;
  }

  function show(clientX: number): void {
    const rect = svg.getBoundingClientRect();
    const fx = ((clientX - rect.left) / rect.width) * width;
    const i = Math.round((((fx - pad) / (width - 2 * pad)) * maxDist) / SAMPLE_STEP_M);
    at = draw(i);
    onPoint(at);
  }

  /** `keepPoint` leaves the map's marker up, because a commit just claimed it. */
  function hide(keepPoint = false): void {
    for (const el of shown) el.setAttribute('visibility', 'hidden');
    at = null;
    if (!keepPoint) onPoint(null);
  }

  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    show(e.clientX);
  });
  svg.addEventListener('pointermove', (e) => {
    if (e.buttons > 0 || e.pointerType === 'mouse') show(e.clientX);
  });
  svg.addEventListener('pointerup', () => {
    // Letting go commits, as with a via marker, so you can scrub along until
    // the crosshair reads the distance you meant and only then release.
    if (onCommit && at !== null) {
      const i = at;
      hide(true);
      onCommit(i);
      return;
    }
    hide();
  });
  svg.addEventListener('pointercancel', () => hide());
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });

  container.appendChild(svg);

  return {
    showSample(sampleIndex) {
      // No `at`: a crosshair the map put here is not a scrub, so letting go
      // over the chart afterwards must not commit this distance as a pick.
      draw(sampleIndex);
    },
    hideSample() {
      hide(true);
    },
  };
}
