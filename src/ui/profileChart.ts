import { SAMPLE_STEP_M } from '../gpx/profile';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ProfileSeries {
  samples: Float32Array;
  color: string;
}

export function renderProfileChart(
  container: HTMLElement,
  series: ProfileSeries[],
  width = 360,
  height = 120,
): void {
  container.textContent = '';
  if (series.length === 0) return;

  let min = Infinity;
  let max = -Infinity;
  let maxDist = 0;
  for (const s of series) {
    for (const v of s.samples) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    maxDist = Math.max(maxDist, (s.samples.length - 1) * SAMPLE_STEP_M);
  }
  if (max - min < 10) max = min + 10;

  const pad = 4;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Elevation profile');

  const x = (i: number) =>
    pad + ((i * SAMPLE_STEP_M) / maxDist) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((v - min) / (max - min)) * (height - 2 * pad);

  for (const s of series) {
    const points: string[] = [];
    for (let i = 0; i < s.samples.length; i++) {
      points.push(`${x(i).toFixed(1)},${y(s.samples[i]!).toFixed(1)}`);
    }
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', s.color);
    line.setAttribute('stroke-width', '1.5');
    svg.appendChild(line);
  }

  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('x', String(width - pad));
  label.setAttribute('y', '12');
  label.setAttribute('text-anchor', 'end');
  label.setAttribute('font-size', '10');
  label.setAttribute('fill', 'currentColor');
  label.textContent = `${(maxDist / 1000).toFixed(1)} km, ${Math.round(min)}–${Math.round(max)} m`;
  svg.appendChild(label);

  container.appendChild(svg);
}

/**
 * Overlaid target/course chart where touching or dragging shows a crosshair
 * with distance, elevation and grade, and reports the sample index so the
 * matching point can be highlighted on the map.
 */
export function renderInteractiveChart(
  container: HTMLElement,
  target: Float32Array,
  course: Float32Array,
  onPoint: (sampleIndex: number | null) => void,
  width = 360,
  height = 140,
): void {
  container.textContent = '';

  let min = Infinity;
  let max = -Infinity;
  for (const s of [target, course]) {
    for (const v of s) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (max - min < 10) max = min + 10;
  const maxDist = (Math.max(target.length, course.length) - 1) * SAMPLE_STEP_M;

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

  for (const { samples, color } of [
    { samples: target, color: '#9ca3af' },
    { samples: course, color: '#dc2626' },
  ]) {
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

  const COURSE_COLOR = '#dc2626';
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
  const targetDot = makeDot(TARGET_COLOR);
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
  const targetText = makeText(TARGET_COLOR, 25);

  function gradeAt(samples: Float32Array, i: number): number {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(samples.length - 1, i + 1);
    if (i1 === i0) return 0;
    return ((samples[i1]! - samples[i0]!) / ((i1 - i0) * SAMPLE_STEP_M)) * 100;
  }

  function show(clientX: number): void {
    const rect = svg.getBoundingClientRect();
    const fx = ((clientX - rect.left) / rect.width) * width;
    let i = Math.round((((fx - pad) / (width - 2 * pad)) * maxDist) / SAMPLE_STEP_M);
    i = Math.max(0, Math.min(i, course.length - 1));
    const cx = x(i);
    crosshair.setAttribute('x1', String(cx));
    crosshair.setAttribute('x2', String(cx));
    crosshair.setAttribute('y1', String(padTop));
    crosshair.setAttribute('y2', String(height - pad));
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(y(course[i]!)));

    const anchorEnd = cx > width / 2;
    const anchor = anchorEnd ? 'end' : 'start';
    const tx = String(anchorEnd ? cx - 6 : cx + 6);
    const km = ((i * SAMPLE_STEP_M) / 1000).toFixed(2);
    text.textContent = `${km} km · ${course[i]!.toFixed(0)} m · ${gradeAt(course, i).toFixed(1)} %`;
    text.setAttribute('text-anchor', anchor);
    text.setAttribute('x', tx);

    const ti = Math.min(i, target.length - 1);
    targetDot.setAttribute('cx', String(x(ti)));
    targetDot.setAttribute('cy', String(y(target[ti]!)));
    targetText.textContent = `race: ${target[ti]!.toFixed(0)} m · ${gradeAt(target, ti).toFixed(1)} %`;
    targetText.setAttribute('text-anchor', anchor);
    targetText.setAttribute('x', tx);

    for (const el of [crosshair, dot, text, targetDot, targetText]) {
      el.setAttribute('visibility', 'visible');
    }
    onPoint(i);
  }

  function hide(): void {
    for (const el of [crosshair, dot, text, targetDot, targetText]) {
      el.setAttribute('visibility', 'hidden');
    }
    onPoint(null);
  }

  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    show(e.clientX);
  });
  svg.addEventListener('pointermove', (e) => {
    if (e.buttons > 0 || e.pointerType === 'mouse') show(e.clientX);
  });
  svg.addEventListener('pointerup', hide);
  svg.addEventListener('pointercancel', hide);
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });

  container.appendChild(svg);
}
