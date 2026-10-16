import { buildGpx } from '../gpx/export';
import type { CourseResult } from '../shared/messages';

const SURFACE_NAMES = ['paved', 'gravel', 'trail', 'unknown'];

export interface ResultElements {
  stats: HTMLElement;
  advanced: HTMLDetailsElement;
  advancedBody: HTMLElement;
  actions: HTMLElement;
  downloadButton: HTMLButtonElement;
}

export function hideResult(els: ResultElements): void {
  els.stats.hidden = true;
  els.advanced.hidden = true;
  els.actions.hidden = true;
  els.actions.textContent = '';
  els.downloadButton.hidden = true;
}

export function renderResult(
  els: ResultElements,
  course: CourseResult,
  action: { label: string; onAction: () => void },
  onEdit?: { editing: boolean; toggle: () => void },
): void {
  const split = course.surfaceSplit
    .map((f, i) => (f > 0.005 ? `${Math.round(f * 100)} % ${SURFACE_NAMES[i]}` : null))
    .filter((s) => s !== null)
    .join(', ');
  els.stats.hidden = false;
  els.stats.textContent =
    `${(course.lengthM / 1000).toFixed(2)} km, +${Math.round(course.gain)} m / ` +
    `\u2212${Math.round(course.loss)} m \u00b7 mismatch ${course.score.toFixed(1)} \u00b7 ${split}`;

  const terms = Object.entries(course.breakdown ?? {})
    .filter(([, v]) => v >= 0.05)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v.toFixed(1)}`)
    .join(', ');
  els.advanced.hidden = false;
  els.advancedBody.textContent =
    `Mismatch ${course.score.toFixed(2)} — lower is better, and only comparable between ` +
    `courses scored with the same weights.` +
    (terms ? ` Contributions: ${terms}.` : '') +
    ` Seed ${course.seed}. ${course.exportPoints.length} points at 25 m spacing.`;

  els.downloadButton.hidden = false;
  els.downloadButton.onclick = () => {
    const gpx = buildGpx(
      `Profile course ${(course.lengthM / 1000).toFixed(1)} km`,
      `Match score ${course.score.toFixed(2)} (seed ${course.seed})`,
      course.exportPoints,
    );
    const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'profile-course.gpx';
    a.click();
    URL.revokeObjectURL(url);
  };

  els.actions.hidden = false;
  els.actions.textContent = '';
  const actionButton = document.createElement('button');
  actionButton.textContent = action.label;
  actionButton.addEventListener('click', action.onAction);
  els.actions.appendChild(actionButton);

  if (onEdit) {
    const edit = document.createElement('button');
    edit.textContent = onEdit.editing ? 'Exit editing' : 'Edit';
    edit.title = 'Editing mode: pull the course where you want it, or tap a point then its destination';
    edit.addEventListener('click', onEdit.toggle);
    els.actions.appendChild(edit);
  }

  const copyLink = document.createElement('button');
  copyLink.textContent = 'Copy link';
  copyLink.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copyLink.textContent = 'Link copied';
      setTimeout(() => (copyLink.textContent = 'Copy link'), 1500);
    } catch {
      copyLink.textContent = location.href;
    }
  });
  els.actions.appendChild(copyLink);
}
