import { buildTargetProfile, sliceProfile, type TargetProfile } from './gpx/profile';
import { parseGpx, type ParsedGpx } from './gpx/parse';
import { SURFACE_PRESETS } from './search/score';
import { loadSession, requestPersistentStorage, saveSession } from './session';
import type { CourseResult, MainToWorker, WorkerToMain } from './shared/messages';
import { createMap } from './ui/map';
import { renderInteractiveChart, renderProfileChart } from './ui/profileChart';
import { renderResult } from './ui/resultPanel';
import { initSheet } from './ui/sheet';
import SearchWorker from './search/worker?worker';

const map = createMap('map');
const worker = new SearchWorker();
initSheet(
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
const results = document.getElementById('results') as HTMLElement;
const algorithmSelect = document.getElementById('algorithm-select') as HTMLSelectElement;
const distanceInput = document.getElementById('distance-input') as HTMLInputElement;
const rangeControl = document.getElementById('range-control') as HTMLDivElement;
const rangeFrom = document.getElementById('range-from') as HTMLInputElement;
const rangeTo = document.getElementById('range-to') as HTMLInputElement;
const surfaceSelect = document.getElementById('surface-select') as HTMLSelectElement;
const returnToggle = document.getElementById('return-toggle') as HTMLInputElement;
const startAtPointToggle = document.getElementById('start-at-point') as HTMLInputElement;
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
      startAtPoint: startAtPointToggle.checked,
      seed,
    },
    result: lastResult,
  });
}

function showResult(result: { course: CourseResult; profile: TargetProfile }): void {
  map.drawCourse(result.course.segments);
  map.decorateCourse(result.course.exportPoints);
  const points = result.course.exportPoints;
  // The combined chart replaces the target-only chart at the top of the sheet.
  renderInteractiveChart(targetChart, result.profile.samples, result.course.samples, (i) => {
    if (i === null) map.hideCoursePoint();
    else map.showCoursePoint(points[Math.min(i, points.length - 1)]!);
  });
  renderResult(results, result.course, () => {
    seed += 1;
    startSearch();
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
  if (params.has('sap')) startAtPointToggle.checked = params.get('sap') === '1';
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
  if (startAtPointToggle.checked) params.set('sap', '1');
  history.replaceState(null, '', `#${params.toString()}`);
}

function startSearch(): void {
  const start = map.getStart();
  const profile = activeProfile();
  if (!start || !profile) return;
  searching = true;
  results.hidden = true;
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
    startAtPoint: startAtPointToggle.checked || returnToggle.checked,
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
    case 'noCourse':
      startHint.textContent = msg.message;
      map.clearCourse();
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
  renderProfileChart(targetChart, [{ samples: profile.samples, color: '#2563eb' }]);
  rangeControl.hidden = false;
  const totalKm = profile.totalDistance / 1000;
  rangeTo.max = totalKm.toFixed(1);
  rangeFrom.max = rangeTo.max;
  if (!rangeFrom.value) rangeFrom.value = '0';
  if (!rangeTo.value || Number(rangeTo.value) > totalKm) rangeTo.value = totalKm.toFixed(1);
  if (!distanceInput.value) distanceInput.value = totalKm.toFixed(1);
  updateRangeLabel();
  updateFindEnabled();
  persistSession();
}

function updateRangeLabel(): void {
  rangeLabel.textContent = `${Number(rangeFrom.value).toFixed(1)} – ${Number(rangeTo.value).toFixed(1)} km`;
}

function refreshTargetChart(): void {
  const profile = activeProfile();
  if (!profile) return;
  renderProfileChart(targetChart, [{ samples: profile.samples, color: '#2563eb' }]);
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
  downloadAreaButton.disabled = false;
  updateFindEnabled();
  persistSession();
});

for (const el of [
  surfaceSelect,
  returnToggle,
  startAtPointToggle,
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
  seed = 1;
  startSearch();
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
    startAtPointToggle.checked = session.settings.startAtPoint ?? false;
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

  const storageInfo = document.getElementById('storage-info') as HTMLParagraphElement;
  storageInfo.textContent = await requestPersistentStorage();
}

void boot();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('sw:', err));
}
