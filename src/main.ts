import { buildTargetProfile, SAMPLE_STEP_M, sliceProfile, type TargetProfile } from './gpx/profile';
import { parseGpx, type ParsedGpx } from './gpx/parse';
import { SURFACE_PRESETS } from './search/score';
import { loadSession, requestPersistentStorage, saveSession } from './session';
import type { CourseResult, MainToWorker, WorkerToMain } from './shared/messages';
import { createMap } from './ui/map';
import { renderInteractiveChart } from './ui/profileChart';
import { hideResult, renderResult, type ResultElements } from './ui/resultPanel';
import { initSheet } from './ui/sheet';
import SearchWorker from './search/worker?worker';

const map = createMap('map');
const worker = new SearchWorker();
const sheet = initSheet(
  document.getElementById('sheet') as HTMLElement,
  document.getElementById('sheet-handle') as HTMLElement,
);

function send(msg: MainToWorker): void {
  worker.postMessage(msg);
}

const radiusSlider = document.getElementById('radius-slider') as HTMLInputElement;
const radiusValue = document.getElementById('radius-value') as HTMLOutputElement;
const findButton = document.getElementById('find-button') as HTMLButtonElement;
const cancelButton = document.getElementById('cancel-button') as HTMLButtonElement;
const startHint = document.getElementById('start-hint') as HTMLParagraphElement;
const gpxInput = document.getElementById('gpx-input') as HTMLInputElement;
const gpxStats = document.getElementById('gpx-stats') as HTMLParagraphElement;
const targetChart = document.getElementById('target-chart') as HTMLDivElement;
const algorithmSelect = document.getElementById('algorithm-select') as HTMLSelectElement;
const resultEls: ResultElements = {
  stats: document.getElementById('course-stats') as HTMLElement,
  advanced: document.getElementById('course-advanced') as HTMLDetailsElement,
  advancedBody: document.getElementById('course-advanced-body') as HTMLElement,
  actions: document.getElementById('course-actions') as HTMLElement,
  downloadButton: document.getElementById('download-gpx') as HTMLButtonElement,
};
const seedInput = document.getElementById('seed-input') as HTMLInputElement;
const coordLat = document.getElementById('coord-lat') as HTMLInputElement;
const coordLon = document.getElementById('coord-lon') as HTMLInputElement;
const coordSet = document.getElementById('coord-set') as HTMLButtonElement;
const WEIGHT_FIELDS = [
  'localShape',
  'gainLoss',
  'turns',
  'surface',
  'penalty',
  'oscillation',
  'trafficLights',
];

function collectWeights(): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const f of WEIGHT_FIELDS) {
    const el = document.getElementById(`w-${f}`) as HTMLInputElement;
    const v = Number(el.value);
    if (Number.isFinite(v)) out[f] = v;
  }
  // Dense turns and far repeats scale with their main sliders. Repeat tracks
  // oscillation at the default 30:80 ratio (laps were nearly free at 10).
  if (out['turns'] !== undefined) out['denseTurns'] = out['turns'];
  if (out['oscillation'] !== undefined) out['repeat'] = (out['oscillation'] * 3) / 8;
  return out;
}
const distanceInput = document.getElementById('distance-input') as HTMLInputElement;
const rangeControl = document.getElementById('range-control') as HTMLDivElement;
const rangeFrom = document.getElementById('range-from') as HTMLInputElement;
const rangeTo = document.getElementById('range-to') as HTMLInputElement;
const surfaceSelect = document.getElementById('surface-select') as HTMLSelectElement;
const returnToggle = document.getElementById('return-toggle') as HTMLInputElement;
const startAnywhereToggle = document.getElementById('start-anywhere') as HTMLInputElement;
const connectorsToggle = document.getElementById('connectors-toggle') as HTMLInputElement;
const areaRadius = document.getElementById('area-radius') as HTMLSelectElement;
const downloadAreaButton = document.getElementById('download-area') as HTMLButtonElement;
const areaProgress = document.getElementById('area-progress') as HTMLProgressElement;
const areasList = document.getElementById('areas-list') as HTMLUListElement;
const rangeLabel = document.getElementById('range-label') as HTMLOutputElement;

let fullProfile: TargetProfile | null = null;
let pendingGpx: ParsedGpx | null = null;
let seed = 1;
let searching = false;
let gpxLabel: string | null = null;
let lastResult: { course: CourseResult; profile: TargetProfile } | null = null;

function persistSession(): void {
  saveSession({
    profile: fullProfile,
    gpxLabel,
    settings: {
      start: map.getStart(),
      radiusKm: radiusSlider.value,
      distanceKm: distanceInput.value,
      rangeFromKm: rangeFrom.value,
      rangeToKm: rangeTo.value,
      surface: surfaceSelect.value,
      returnToStart: returnToggle.checked,
      startAnywhere: startAnywhereToggle.checked,
      viaPoints,
      seed,
    },
    result: lastResult,
  });
}

function showResult(
  result: { course: CourseResult; profile: TargetProfile },
  action?: { label: string; onAction: () => void },
): void {
  lastAction = action;
  map.drawCourse(result.course.segments);
  map.decorateCourse(result.course.exportPoints);
  const points = result.course.exportPoints;
  // The combined chart replaces the target-only chart at the top of the sheet.
  renderInteractiveChart(targetChart, result.profile.samples, result.course.samples, (i) => {
    if (i === null) {
      map.hideCoursePoint();
      return;
    }
    lastChartKm = (i * SAMPLE_STEP_M) / 1000;
    map.showCoursePoint(points[Math.min(i, points.length - 1)]!);
  });
  renderResult(
    resultEls,
    result.course,
    action ?? {
      label: 'Try another',
      onAction: () => {
        seed += 1;
        seedInput.value = String(seed);
        startSearch();
      },
    },
    {
      editing: editingMode,
      toggle: () => toggleEditing(result),
      undo: editingMode && editHistory.length > 0 ? undoEdit : undefined,
    },
  );
}

/**
 * Persistent editing mode: pull the course somewhere else, or tap a course
 * point then tap its destination. Either way the mode stays armed, and each
 * reroute builds on the previous one, until Exit editing.
 */
let editingMode = false;
let lastAction: { label: string; onAction: () => void } | undefined;
/** Courses replaced by an edit, newest last, for Undo. */
const editHistory: { course: CourseResult; profile: TargetProfile }[] = [];
/** Where edits have landed, drawn on the map while editing. */
let editedPoints: { lat: number; lon: number }[] = [];

function toggleEditing(result: { course: CourseResult; profile: TargetProfile }): void {
  if (editingMode) {
    exitEditing();
    return;
  }
  editingMode = true;
  if (lastResult) showResult(lastResult, lastAction); // refresh button label
  armEditing(result);
}

function exitEditing(): void {
  editingMode = false;
  map.disarmViaPlacement();
  map.disarmCourseDrag();
  map.hideCoursePoint();
  map.setEditMarkers([]);
  editedPoints = [];
  editHistory.length = 0;
  startHint.textContent = 'Editing finished.';
  if (lastResult) showResult(lastResult, lastAction);
}

function sendEdit(
  result: { course: CourseResult; profile: TargetProfile },
  atKm: number,
  to: { lat: number; lon: number },
): void {
  editHistory.push(result);
  editedPoints.push(to);
  map.setEditMarkers(editedPoints);
  map.hideCoursePoint();
  startHint.textContent = 'Rerouting…';
  send({
    type: 'editCourse',
    atKm,
    to,
    ...coursePointArrays(result.course),
    target: targetTransfer(result.profile),
    desiredMix: SURFACE_PRESETS[surfaceSelect.value] ?? SURFACE_PRESETS['road']!,
    weights: collectWeights(),
    resync: workerCourseStale,
  });
  workerCourseStale = false;
}

/** True when the worker still holds a course we have since moved away from. */
let workerCourseStale = false;

function undoEdit(): void {
  const previous = editHistory.pop();
  if (!previous) return;
  workerCourseStale = true; // the worker's cached path is the edit we just dropped
  editedPoints.pop();
  map.setEditMarkers(editedPoints);
  lastResult = previous;
  showResult(previous, lastAction);
  startHint.textContent = `Edit undone — mismatch back to ${previous.course.score.toFixed(1)}.`;
  persistSession();
  armEditing(previous);
}

function armEditing(result: { course: CourseResult; profile: TargetProfile }): void {
  const points = result.course.exportPoints;
  startHint.textContent = 'Editing: pull the course where you want it, or tap a point on it.';
  map.setEditMarkers(editedPoints);

  const selectDestination = (index: number) => {
    const atKm = (index * SAMPLE_STEP_M) / 1000;
    map.showCoursePoint(points[index]!);
    // While waiting for the destination, a tap near the course must not be
    // swallowed as a new pull.
    map.disarmCourseDrag();
    startHint.textContent = `Editing: rerouting near km ${atKm.toFixed(1)} — tap where the course should go…`;
    map.armViaPlacement((to) => sendEdit(result, atKm, to));
  };

  map.armCourseDrag(points, (index, to, dragged) => {
    if (dragged) sendEdit(result, (index * SAMPLE_STEP_M) / 1000, to);
    else selectDestination(index);
  });
  map.armViaPlacement((p) => {
    // A tap away from the course still picks the nearest course point.
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dLat = points[i]!.lat - p.lat;
      const dLon = points[i]!.lon - p.lon;
      const d = dLat * dLat + dLon * dLon;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    selectDestination(bestI);
  });
}

/** The profile actually searched for: the race window, rebased. */
function activeProfile(): TargetProfile | null {
  if (!fullProfile) return null;
  const fromM = Math.max(0, Number(rangeFrom.value) * 1000 || 0);
  const toM = Math.min(fullProfile.totalDistance, Number(rangeTo.value) * 1000 || fullProfile.totalDistance);
  if (fromM <= 0 && toM >= fullProfile.totalDistance) return fullProfile;
  if (toM - fromM < 500) return fullProfile;
  return sliceProfile(fullProfile, fromM, toM);
}

function readUrlState(): void {
  const params = new URLSearchParams(location.hash.slice(1));
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (Number.isFinite(lat) && Number.isFinite(lon) && params.has('lat')) {
    map.setStart({ lat, lon });
  }
  if (params.has('r')) radiusSlider.value = params.get('r')!;
  if (params.has('d')) distanceInput.value = params.get('d')!;
  if (params.has('from')) rangeFrom.value = params.get('from')!;
  if (params.has('to')) rangeTo.value = params.get('to')!;
  if (params.has('mix')) surfaceSelect.value = params.get('mix')!;
  if (params.has('seed')) seed = Number(params.get('seed')) || 1;
  if (params.has('rts')) returnToggle.checked = params.get('rts') === '1';
  if (params.has('sa')) startAnywhereToggle.checked = params.get('sa') === '1';
  radiusSlider.dispatchEvent(new Event('input'));
}

function writeUrlState(): void {
  const start = map.getStart();
  if (!start) return;
  const params = new URLSearchParams({
    lat: start.lat.toFixed(5),
    lon: start.lon.toFixed(5),
    r: radiusSlider.value,
    mix: surfaceSelect.value,
    seed: String(seed),
  });
  if (distanceInput.value) params.set('d', distanceInput.value);
  if (Number(rangeFrom.value) > 0) params.set('from', rangeFrom.value);
  if (rangeTo.value) params.set('to', rangeTo.value);
  if (returnToggle.checked) params.set('rts', '1');
  if (startAnywhereToggle.checked) params.set('sa', '1');
  history.replaceState(null, '', `#${params.toString()}`);
}

function startSearch(): void {
  const start = map.getStart();
  const profile = activeProfile();
  if (!start || !profile) return;
  if (editingMode) exitEditing();
  searching = true;
  hideResult(resultEls);
  map.clearCourse();
  map.hideCoursePoint();
  refreshTargetChart(); // back to the target-only chart while searching
  findButton.disabled = true;
  findButton.textContent = 'Working…';
  cancelButton.hidden = false;
  cancelButton.style.marginTop = '8px';
  writeUrlState();
  const targetLength = Number(distanceInput.value) * 1000 || profile.totalDistance;
  send({
    type: 'search',
    start,
    radiusMeters: Number(radiusSlider.value) * 1000,
    target: {
      totalDistance: profile.totalDistance,
      samples: profile.samples,
      totalGain: profile.totalGain,
      totalLoss: profile.totalLoss,
      gradientHistogram: profile.gradientHistogram,
      turnsPerKm: profile.turnsPerKm,
    },
    targetLengthMeters: targetLength,
    seed,
    algorithm: algorithmSelect.value === 'walk' ? 'walk' : 'beam',
    desiredMix: SURFACE_PRESETS[surfaceSelect.value] ?? SURFACE_PRESETS['road']!,
    returnToStart: returnToggle.checked,
    startAtPoint: !startAnywhereToggle.checked || returnToggle.checked,
    weights: collectWeights(),
    connectors: connectorsToggle.checked,
    beamWidth:
      Number((document.getElementById('beam-width') as HTMLInputElement).value) || 200,
    viaPoints,
    viaToleranceKm:
      Number((document.getElementById('via-tolerance') as HTMLInputElement).value) || 1,
  });
}

function searchDone(): void {
  searching = false;
  findButton.textContent = 'Find course';
  cancelButton.hidden = true;
  updateFindEnabled();
}

cancelButton.addEventListener('click', () => {
  send({ type: 'cancel' });
  startHint.textContent = 'Search cancelled.';
  searchDone();
});

function renderAreas(areas: import('./shared/messages').AreaInfo[]): void {
  areasList.textContent = '';
  for (const a of areas) {
    const li = document.createElement('li');
    const date = new Date(a.savedAt).toISOString().slice(0, 10);
    li.textContent = `${(a.radiusMeters / 1000).toFixed(0)} km @ ${a.lat.toFixed(3)}, ${a.lon.toFixed(3)} (${a.ways} ways, ${date}) `;
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.style.width = 'auto';
    del.style.minHeight = '28px';
    del.addEventListener('click', () => send({ type: 'deleteArea', id: a.id }));
    li.appendChild(del);
    areasList.appendChild(li);
  }
}

worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'pong':
      console.log('worker alive');
      break;
    case 'areas':
      renderAreas(msg.areas);
      downloadAreaButton.textContent = 'Download area around start';
      downloadAreaButton.disabled = map.getStart() === null;
      areaProgress.hidden = true;
      break;
    case 'elevated': {
      if (!pendingGpx) break;
      const points = pendingGpx.points.map((p, i) => ({ ...p, ele: msg.elevations[i]! }));
      pendingGpx = null;
      setFullProfile(buildTargetProfile(points));
      break;
    }
    case 'prepared':
      console.log(
        `graph ready: ${msg.nodeCount} nodes, ${msg.edgeCount} edges; ` +
          `start node at ${msg.startNode.lat.toFixed(5)}, ${msg.startNode.lon.toFixed(5)}, ` +
          `elevation ${msg.startElevation.toFixed(1)} m`,
      );
      break;
    case 'progress':
      if (msg.stage.startsWith('downloading area')) {
        downloadAreaButton.textContent = msg.stage;
        areaProgress.hidden = false;
        areaProgress.value = msg.fraction;
        break;
      }
      findButton.textContent =
        msg.bestScore !== null
          ? `${msg.stage} ${Math.round(msg.fraction * 100)} % (best ${msg.bestScore.toFixed(1)})`
          : `${msg.stage} ${Math.round(msg.fraction * 100)} %`;
      break;
    case 'bestSoFar':
      map.drawCourse(msg.segments, { faded: true });
      break;
    case 'result': {
      const profile = activeProfile();
      if (profile) {
        lastResult = { course: msg.course, profile };
        showResult(lastResult);
        persistSession();
      }
      searchDone();
      break;
    }
    case 'matched': {
      const profile = activeProfile();
      if (profile) {
        lastResult = { course: msg.course, profile };
        showResult(lastResult, { label: 'Improve this course', onAction: sendImproveMatched });
        startHint.textContent =
          msg.snappedFraction < 0.9
            ? `Matched ${Math.round(msg.snappedFraction * 100)} % of the course to the path network.`
            : `Course updated — mismatch ${msg.course.score.toFixed(1)}.`;
        persistSession();
        // Stay in editing mode: re-arm on the updated course.
        if (editingMode) armEditing(lastResult);
      }
      searchDone();
      break;
    }
    case 'noCourse':
      clearResult();
      startHint.textContent = msg.message;
      searchDone();
      break;
    case 'error':
      console.warn('worker:', msg.message);
      startHint.textContent = msg.message;
      downloadAreaButton.textContent = 'Download area around start';
      downloadAreaButton.disabled = map.getStart() === null;
      areaProgress.hidden = true;
      searchDone();
      break;
  }
};
send({ type: 'ping' });
send({ type: 'listAreas' });

downloadAreaButton.addEventListener('click', () => {
  const start = map.getStart();
  if (!start) return;
  downloadAreaButton.disabled = true;
  downloadAreaButton.textContent = 'Downloading…';
  send({ type: 'downloadArea', center: start, radiusMeters: Number(areaRadius.value) * 1000 });
});

function setFullProfile(profile: TargetProfile): void {
  fullProfile = profile;
  gpxStats.hidden = false;
  const label = gpxLabel ? `${gpxLabel}: ` : '';
  gpxStats.textContent = `${label}${(profile.totalDistance / 1000).toFixed(1)} km, +${Math.round(profile.totalGain)} m / \u2212${Math.round(profile.totalLoss)} m`;
  rangeControl.hidden = false;
  const totalKm = profile.totalDistance / 1000;
  rangeTo.max = totalKm.toFixed(1);
  rangeFrom.max = rangeTo.max;
  if (!rangeFrom.value) rangeFrom.value = '0';
  if (!rangeTo.value || Number(rangeTo.value) > totalKm) rangeTo.value = totalKm.toFixed(1);
  if (!distanceInput.value) distanceInput.value = totalKm.toFixed(1);
  updateRangeLabel();
  clearResult(); // a new race invalidates whatever course was on screen
  refreshTargetChart();
  updateFindEnabled();
  persistSession();
}

/** Drop the proposed course: no stats, no advanced stats, no course buttons. */
function clearResult(): void {
  if (editingMode) exitEditing();
  lastResult = null;
  lastAction = undefined;
  editHistory.length = 0;
  hideResult(resultEls);
  map.clearCourse();
  map.hideCoursePoint();
  map.setEditMarkers([]);
}

function updateRangeLabel(): void {
  rangeLabel.textContent = `${Number(rangeFrom.value).toFixed(1)} – ${Number(rangeTo.value).toFixed(1)} km`;
}

/** Km last touched on the chart, so a pick can be committed on release. */
let lastChartKm: number | null = null;

function refreshTargetChart(): void {
  const profile = activeProfile();
  if (!profile) return;
  // Scrubbable even without a course, to read off height/grade/distance.
  renderInteractiveChart(targetChart, profile.samples, null, (i) => {
    lastChartKm = i === null ? lastChartKm : (i * SAMPLE_STEP_M) / 1000;
  });
  if (profile !== fullProfile) {
    distanceInput.value = (profile.totalDistance / 1000).toFixed(1);
  }
}

// Dual-handle slider: keep the handles at least 0.5 km apart.
rangeFrom.addEventListener('input', () => {
  if (Number(rangeFrom.value) > Number(rangeTo.value) - 0.5) {
    rangeFrom.value = String(Math.max(0, Number(rangeTo.value) - 0.5));
  }
  updateRangeLabel();
  refreshTargetChart();
});
rangeTo.addEventListener('input', () => {
  if (Number(rangeTo.value) < Number(rangeFrom.value) + 0.5) {
    rangeTo.value = String(Math.min(Number(rangeTo.max), Number(rangeFrom.value) + 0.5));
  }
  updateRangeLabel();
  refreshTargetChart();
});

const compareInput = document.getElementById('compare-input') as HTMLInputElement;
const viaList = document.getElementById('via-list') as HTMLUListElement;
const addViaButton = document.getElementById('add-via') as HTMLButtonElement;

let viaPoints: { lat: number; lon: number; km: number | null }[] = [];

function renderVias(): void {
  map.setViaMarkers(viaPoints, (i, p) => {
    viaPoints[i] = { ...viaPoints[i]!, lat: p.lat, lon: p.lon };
    renderVias();
    persistSession();
  });
  viaList.textContent = '';
  viaPoints.forEach((v, i) => {
    const li = document.createElement('li');
    li.textContent = `${i + 1}: ${v.lat.toFixed(4)}, ${v.lon.toFixed(4)} — km `;
    const km = document.createElement('input');
    km.type = 'number';
    km.min = '0';
    km.step = '0.1';
    km.placeholder = 'any';
    km.style.width = '70px';
    if (v.km !== null) km.value = String(v.km);
    km.addEventListener('change', () => {
      viaPoints[i]!.km = km.value === '' ? null : Math.max(0, Number(km.value));
      persistSession();
    });
    li.appendChild(km);
    const pick = document.createElement('button');
    pick.textContent = 'pick on chart';
    pick.style.width = 'auto';
    pick.style.minHeight = '28px';
    pick.style.marginLeft = '8px';
    pick.addEventListener('click', () => {
      if (!activeProfile()) return;
      // Bring the chart into view, then let the finger slide and commit on release.
      sheet.restore();
      targetChart.scrollIntoView({ behavior: 'smooth', block: 'center' });
      startHint.textContent = 'Slide along the elevation chart and let go at the right km…';
      const commit = () => {
        targetChart.removeEventListener('pointerup', commit, true);
        targetChart.removeEventListener('pointercancel', commit, true);
        if (lastChartKm === null) return;
        viaPoints[i]!.km = Math.round(lastChartKm * 10) / 10;
        startHint.textContent = `Via ${i + 1} set to km ${viaPoints[i]!.km}`;
        renderVias();
        persistSession();
      };
      targetChart.addEventListener('pointerup', commit, true);
      targetChart.addEventListener('pointercancel', commit, true);
    });
    li.appendChild(pick);
    if (i > 0) {
      const up = document.createElement('button');
      up.textContent = '↑';
      up.title = 'Move earlier in the order';
      up.style.width = 'auto';
      up.style.minHeight = '28px';
      up.style.marginLeft = '8px';
      up.addEventListener('click', () => {
        [viaPoints[i - 1], viaPoints[i]] = [viaPoints[i]!, viaPoints[i - 1]!];
        renderVias();
        persistSession();
      });
      li.appendChild(up);
    }
    const del = document.createElement('button');
    del.textContent = '×';
    del.style.width = 'auto';
    del.style.minHeight = '28px';
    del.style.marginLeft = '8px';
    del.addEventListener('click', () => {
      viaPoints.splice(i, 1);
      renderVias();
      persistSession();
    });
    li.appendChild(del);
    viaList.appendChild(li);
  });
  addViaButton.disabled = false;
}

addViaButton.addEventListener('click', () => {
  addViaButton.textContent = 'Tap the map to place the via point…';
  startHint.textContent = 'Tap the map to place the via point…';
  sheet.collapse(); // get the menu out of the way of the map
  map.armViaPlacement((p) => {
    viaPoints.push({ lat: p.lat, lon: p.lon, km: null });
    addViaButton.textContent = 'Add via point (then tap the map)';
    renderVias();
    persistSession();
    sheet.restore();
  });
});

function targetTransfer(profile: TargetProfile) {
  return {
    totalDistance: profile.totalDistance,
    samples: profile.samples,
    totalGain: profile.totalGain,
    totalLoss: profile.totalLoss,
    gradientHistogram: profile.gradientHistogram,
    turnsPerKm: profile.turnsPerKm,
  };
}

function coursePointArrays(course: CourseResult): { lats: Float64Array; lons: Float64Array } {
  return {
    lats: new Float64Array(course.exportPoints.map((p) => p.lat)),
    lons: new Float64Array(course.exportPoints.map((p) => p.lon)),
  };
}

function sendImproveMatched(): void {
  const profile = activeProfile();
  if (!profile || !lastResult) return;
  findButton.disabled = true;
  findButton.textContent = 'Improving…';
  send({
    type: 'improveCourse',
    ...coursePointArrays(lastResult.course),
    target: targetTransfer(profile),
    desiredMix: SURFACE_PRESETS[surfaceSelect.value] ?? SURFACE_PRESETS['road']!,
    weights: collectWeights(),
    resync: workerCourseStale,
  });
  workerCourseStale = false;
}

compareInput.addEventListener('change', async () => {
  const file = compareInput.files?.[0];
  const profile = activeProfile();
  if (!file) return;
  if (!profile) {
    startHint.textContent = 'Load the race GPX first, then the comparison course.';
    return;
  }
  try {
    const gpx = parseGpx(await file.text());
    findButton.disabled = true;
    findButton.textContent = 'Matching course…';
    send({
      type: 'matchCourse',
      lats: new Float64Array(gpx.points.map((p) => p.lat)),
      lons: new Float64Array(gpx.points.map((p) => p.lon)),
      target: targetTransfer(profile),
      desiredMix: SURFACE_PRESETS[surfaceSelect.value] ?? SURFACE_PRESETS['road']!,
      weights: collectWeights(),
    });
  } catch (err) {
    startHint.textContent = err instanceof Error ? err.message : String(err);
  }
});

gpxInput.addEventListener('change', async () => {
  const file = gpxInput.files?.[0];
  if (!file) return;
  try {
    const gpx = parseGpx(await file.text());
    gpxLabel = gpx.name ?? file.name;
    lastResult = null;
    if (gpx.hasElevation) {
      setFullProfile(buildTargetProfile(gpx.points));
    } else {
      gpxStats.hidden = false;
      gpxStats.textContent = 'No elevation in GPX; fetching from terrain model…';
      pendingGpx = gpx;
      const lats = new Float64Array(gpx.points.map((p) => p.lat));
      const lons = new Float64Array(gpx.points.map((p) => p.lon));
      send({ type: 'elevate', lats, lons });
    }
  } catch (err) {
    gpxStats.hidden = false;
    gpxStats.textContent = err instanceof Error ? err.message : String(err);
    fullProfile = null;
    updateFindEnabled();
  }
});

radiusSlider.addEventListener('input', () => {
  const km = Number(radiusSlider.value);
  radiusValue.textContent = km.toFixed(1);
  map.setRadius(km * 1000);
});

map.onStartChange((start) => {
  startHint.textContent = `Start: ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)} (drag to adjust)`;
  coordLat.value = start.lat.toFixed(5);
  coordLon.value = start.lon.toFixed(5);
  downloadAreaButton.disabled = false;
  updateFindEnabled();
  persistSession();
});

for (const el of [
  surfaceSelect,
  returnToggle,
  startAnywhereToggle,
  distanceInput,
  rangeFrom,
  rangeTo,
  radiusSlider,
]) {
  el.addEventListener('change', persistSession);
}

function updateFindEnabled(): void {
  if (searching) return;
  findButton.disabled = !(fullProfile !== null && map.getStart() !== null);
}

findButton.addEventListener('click', () => {
  seed = Math.max(1, Math.round(Number(seedInput.value)) || 1);
  startSearch();
});

coordSet.addEventListener('click', () => {
  const lat = Number(coordLat.value);
  const lon = Number(coordLon.value);
  if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) {
    map.setStart({ lat, lon });
  }
});

async function boot(): Promise<void> {
  const session = await loadSession();
  if (session) {
    gpxLabel = session.gpxLabel;
    seed = session.settings.seed || 1;
    if (session.settings.radiusKm) radiusSlider.value = session.settings.radiusKm;
    if (session.settings.distanceKm) distanceInput.value = session.settings.distanceKm;
    if (session.settings.rangeFromKm) rangeFrom.value = session.settings.rangeFromKm;
    if (session.settings.rangeToKm) rangeTo.value = session.settings.rangeToKm;
    if (session.settings.surface) surfaceSelect.value = session.settings.surface;
    returnToggle.checked = session.settings.returnToStart;
    startAnywhereToggle.checked = session.settings.startAnywhere ?? false;
    viaPoints = session.settings.viaPoints ?? [];
    renderVias();
    if (session.profile) setFullProfile(session.profile);
    if (session.settings.start) map.setStart(session.settings.start);
    radiusSlider.dispatchEvent(new Event('input'));
    if (session.result) {
      lastResult = session.result;
      showResult(session.result);
    }
  }
  // Explicit URL parameters win over the restored session.
  readUrlState();
  renderVias();

  const storageInfo = document.getElementById('storage-info') as HTMLParagraphElement;
  storageInfo.textContent = await requestPersistentStorage();
}

void boot();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('sw:', err));
}
