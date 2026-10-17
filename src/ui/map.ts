import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import { bearingDeg } from '../shared/geo';
import type { CourseSegment, LatLon } from '../shared/messages';

const SURFACE_COLORS = ['#2563eb', '#d97706', '#16a34a', '#6b7280'];
const KM_SAMPLE_STRIDE = 40; // 1000 m / 25 m
const ARROW_SAMPLE_STRIDE = 20; // every ~500 m
/** Above markerPane (600), so edit markers never hide behind km labels. */
const EDIT_PANE = 'editPane';
const GRAB_RADIUS_PX = 28;
const DRAG_THRESHOLD_PX = 12;

// Leaflet's _getIconUrl builds paths from imagePath, bypassing the bundler's
// hashed asset URLs; removing it makes mergeOptions URLs win.
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)['_getIconUrl'];
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

export interface MapController {
  getStart(): LatLon | null;
  setStart(start: LatLon): void;
  setRadius(meters: number): void;
  onStartChange(cb: (start: LatLon) => void): void;
  /** The next map tap calls cb instead of placing the start marker. */
  armViaPlacement(cb: (p: LatLon) => void): void;
  /** Cancel a pending armViaPlacement callback. */
  disarmViaPlacement(): void;
  /** Redraws numbered, draggable via markers. */
  setViaMarkers(vias: LatLon[], onMove: (index: number, p: LatLon) => void): void;
  /** Dots showing where the course has already been edited. */
  setEditMarkers(points: LatLon[]): void;
  /** Dots on every junction of the course, for node editing. */
  setNodeMarkers(points: LatLon[]): void;
  /**
   * Press on the course and pull it somewhere else. `dragged` is false when the
   * press was really a tap, so the caller can fall back to a two-tap flow.
   */
  armCourseDrag(
    points: LatLon[],
    handlers: {
      onPull: (index: number, to: LatLon, dragged: boolean) => void;
      onGrab?: (index: number) => void;
      /** The fixed points the pulled stretch stays attached to, for the drag preview. */
      anchors?: (index: number) => readonly [LatLon, LatLon] | null;
    },
  ): void;
  disarmCourseDrag(): void;
  /** Translucent box over the stretch an edit may rewrite. */
  showEditWindow(points: LatLon[]): void;
  hideEditWindow(): void;
  drawCourse(segments: CourseSegment[], options?: { faded?: boolean }): void;
  /** Km labels and running-direction arrows along ~25 m-spaced course points. */
  decorateCourse(points: { lat: number; lon: number }[]): void;
  clearCourse(): void;
  showCoursePoint(point: LatLon): void;
  hideCoursePoint(): void;
}

export function createMap(container: string): MapController {
  const map = L.map(container, { zoomControl: false }).setView([57.7089, 11.9746], 12);
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.createPane(EDIT_PANE).style.zIndex = '680';

  // GoKartor as a second layer was tried and blocked (licensing protection);
  // ask Gokartor AB for permission before re-adding.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  let marker: L.Marker | null = null;
  let circle: L.Circle | null = null;
  let radiusMeters = 5000;
  let changeCb: ((start: LatLon) => void) | null = null;

  function notify(): void {
    if (marker && changeCb) {
      const { lat, lng } = marker.getLatLng();
      changeCb({ lat, lon: lng });
    }
  }

  function placeStart(latlng: L.LatLng): void {
    if (!marker) {
      marker = L.marker(latlng, { draggable: true }).addTo(map);
      circle = L.circle(latlng, { radius: radiusMeters, color: '#2563eb', weight: 2, fillOpacity: 0.05 }).addTo(map);
      marker.on('move', () => {
        circle?.setLatLng(marker!.getLatLng());
      });
      marker.on('moveend', notify);
    } else {
      marker.setLatLng(latlng);
      circle?.setLatLng(latlng);
    }
    notify();
  }

  let viaTapCb: ((p: LatLon) => void) | null = null;
  let lastDragEnd = 0;
  map.on('click', (e: L.LeafletMouseEvent) => {
    // A pulled course emits a trailing click on touch; don't treat it as a tap.
    if (Date.now() - lastDragEnd < 400) return;
    if (viaTapCb) {
      const cb = viaTapCb;
      viaTapCb = null;
      cb({ lat: e.latlng.lat, lon: e.latlng.lng });
      return;
    }
    placeStart(e.latlng);
  });

  let courseLayer: L.LayerGroup | null = null;
  let pointMarker: L.Marker | null = null;
  let viaMarkers: L.Marker[] = [];
  let editMarkers: L.Marker[] = [];
  let nodeLayer: L.LayerGroup | null = null;

  let pullCb: ((index: number, to: LatLon, dragged: boolean) => void) | null = null;
  let grabCb: ((index: number) => void) | null = null;
  let anchorsCb: ((index: number) => readonly [LatLon, LatLon] | null) | null = null;
  let windowBox: L.Rectangle | null = null;
  let pullPoints: LatLon[] = [];
  let pullIndex = -1;
  let pullStart: { x: number; y: number } | null = null;
  let pullAnchors: readonly [LatLon, LatLon] | null = null;
  let rubber: L.Polyline | null = null;
  let rubberPoint: L.Marker | null = null;

  function nearestCoursePoint(e: PointerEvent): number {
    const p = map.mouseEventToContainerPoint(e);
    let best = -1;
    let bestD = GRAB_RADIUS_PX;
    for (let i = 0; i < pullPoints.length; i++) {
      const q = map.latLngToContainerPoint([pullPoints[i]!.lat, pullPoints[i]!.lon]);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  const mapEl = map.getContainer();

  mapEl.addEventListener('pointerdown', (e) => {
    if (!pullCb || pullStart) return;
    const i = nearestCoursePoint(e);
    if (i < 0) return; // away from the course: let the map pan as usual
    pullIndex = i;
    pullStart = { x: e.clientX, y: e.clientY };
    pullAnchors = anchorsCb?.(i) ?? null;
    map.dragging.disable();
    mapEl.setPointerCapture(e.pointerId);
    grabCb?.(i);
  });

  mapEl.addEventListener('pointermove', (e) => {
    if (!pullStart) return;
    const from = pullPoints[pullIndex]!;
    const to = map.mouseEventToLatLng(e);
    // Straight legs from the two points the stretch stays attached to, so it is
    // obvious which part of the course the drag can still move.
    const ends = pullAnchors ?? ([from, from] as const);
    const line: L.LatLngExpression[] = [[ends[0].lat, ends[0].lon], to, [ends[1].lat, ends[1].lon]];
    if (rubber) rubber.setLatLngs(line);
    else {
      rubber = L.polyline(line, {
        pane: EDIT_PANE,
        color: '#7c3aed',
        weight: 4,
        opacity: 0.55,
        dashArray: '6 5',
        interactive: false,
      }).addTo(map);
    }
    if (rubberPoint) rubberPoint.setLatLng(to);
    else {
      rubberPoint = L.marker(to, {
        pane: EDIT_PANE,
        interactive: false,
        icon: L.divIcon({ className: 'dragged-point', iconSize: [14, 14] }),
      }).addTo(map);
    }
  });

  const endPull = (e: PointerEvent, commit: boolean) => {
    if (!pullStart) return;
    const moved = Math.hypot(e.clientX - pullStart.x, e.clientY - pullStart.y);
    const index = pullIndex;
    pullStart = null;
    pullIndex = -1;
    pullAnchors = null;
    rubber?.remove();
    rubber = null;
    rubberPoint?.remove();
    rubberPoint = null;
    map.dragging.enable();
    if (!commit) return;
    lastDragEnd = Date.now();
    const to = map.mouseEventToLatLng(e);
    pullCb?.(index, { lat: to.lat, lon: to.lng }, moved >= DRAG_THRESHOLD_PX);
  };
  mapEl.addEventListener('pointerup', (e) => endPull(e, true));
  mapEl.addEventListener('pointercancel', (e) => endPull(e, false));

  return {
    armViaPlacement(cb) {
      viaTapCb = cb;
    },
    disarmViaPlacement() {
      viaTapCb = null;
    },
    setViaMarkers(vias, onMove) {
      for (const m of viaMarkers) m.remove();
      viaMarkers = vias.map((v, i) => {
        const m = L.marker([v.lat, v.lon], {
          draggable: true,
          icon: L.divIcon({ className: 'via-marker', html: String(i + 1), iconSize: [22, 22] }),
        }).addTo(map);
        m.on('moveend', () => {
          const { lat, lng } = m.getLatLng();
          onMove(i, { lat, lon: lng });
        });
        return m;
      });
    },
    setEditMarkers(points) {
      for (const m of editMarkers) m.remove();
      editMarkers = points.map((p) =>
        L.marker([p.lat, p.lon], {
          pane: EDIT_PANE,
          interactive: false,
          icon: L.divIcon({ className: 'edited-point', iconSize: [12, 12] }),
        }).addTo(map),
      );
    },
    setNodeMarkers(points) {
      nodeLayer?.remove();
      nodeLayer = null;
      if (points.length === 0) return;
      nodeLayer = L.layerGroup();
      for (const p of points) {
        L.marker([p.lat, p.lon], {
          pane: EDIT_PANE,
          interactive: false,
          icon: L.divIcon({ className: 'node-point', iconSize: [10, 10] }),
        }).addTo(nodeLayer);
      }
      nodeLayer.addTo(map);
    },
    armCourseDrag(points, handlers) {
      pullPoints = points;
      pullCb = handlers.onPull;
      grabCb = handlers.onGrab ?? null;
      anchorsCb = handlers.anchors ?? null;
    },
    disarmCourseDrag() {
      pullCb = null;
      grabCb = null;
      anchorsCb = null;
      pullPoints = [];
    },
    showEditWindow(points) {
      if (points.length === 0) return;
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      for (const p of points) {
        minLat = Math.min(minLat, p.lat);
        maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon);
        maxLon = Math.max(maxLon, p.lon);
      }
      const bounds: L.LatLngBoundsLiteral = [
        [minLat, minLon],
        [maxLat, maxLon],
      ];
      if (windowBox) {
        windowBox.setBounds(bounds);
        return;
      }
      windowBox = L.rectangle(bounds, {
        pane: EDIT_PANE,
        interactive: false,
        color: '#7c3aed',
        weight: 1,
        dashArray: '4 4',
        fillOpacity: 0.12,
        className: 'edit-window',
      }).addTo(map);
    },
    hideEditWindow() {
      windowBox?.remove();
      windowBox = null;
    },
    drawCourse(segments, options) {
      courseLayer?.remove();
      courseLayer = L.layerGroup();
      const opacity = options?.faded ? 0.45 : 0.9;
      for (const seg of segments) {
        const latlngs: [number, number][] = [];
        for (let i = 0; i < seg.lats.length; i++) latlngs.push([seg.lats[i]!, seg.lons[i]!]);
        L.polyline(latlngs, {
          color: SURFACE_COLORS[seg.surface] ?? SURFACE_COLORS[3]!,
          weight: 4,
          opacity,
        }).addTo(courseLayer);
      }
      const last = segments[segments.length - 1];
      if (last && !options?.faded) {
        const i = last.lats.length - 1;
        L.circleMarker([last.lats[i]!, last.lons[i]!], {
          radius: 6,
          color: '#111',
          fillColor: '#fff',
          fillOpacity: 1,
        }).addTo(courseLayer);
      }
      courseLayer.addTo(map);
    },
    decorateCourse(points) {
      if (!courseLayer) return;
      for (let i = KM_SAMPLE_STRIDE; i < points.length; i += KM_SAMPLE_STRIDE) {
        const km = i / KM_SAMPLE_STRIDE;
        L.marker([points[i]!.lat, points[i]!.lon], {
          interactive: false,
          icon: L.divIcon({ className: 'km-marker', html: String(km), iconSize: [20, 20] }),
        }).addTo(courseLayer);
      }
      for (let i = ARROW_SAMPLE_STRIDE; i < points.length - 1; i += ARROW_SAMPLE_STRIDE) {
        if (i % KM_SAMPLE_STRIDE === 0) continue; // don't stack on km labels
        const p = points[i]!;
        const q = points[i + 1]!;
        const bearing = bearingDeg(p.lat, p.lon, q.lat, q.lon);
        L.marker([p.lat, p.lon], {
          interactive: false,
          icon: L.divIcon({
            className: 'dir-arrow',
            html: `<span style="transform: rotate(${(bearing - 90).toFixed(0)}deg)">➤</span>`,
            iconSize: [16, 16],
          }),
        }).addTo(courseLayer);
      }
    },
    clearCourse() {
      courseLayer?.remove();
      courseLayer = null;
      windowBox?.remove();
      windowBox = null;
      nodeLayer?.remove();
      nodeLayer = null;
      pointMarker?.remove();
      pointMarker = null;
    },
    showCoursePoint(point) {
      if (!pointMarker) {
        pointMarker = L.marker([point.lat, point.lon], {
          pane: EDIT_PANE,
          interactive: false,
          icon: L.divIcon({ className: 'course-point', iconSize: [16, 16] }),
        }).addTo(map);
      } else {
        pointMarker.setLatLng([point.lat, point.lon]);
      }
    },
    hideCoursePoint() {
      pointMarker?.remove();
      pointMarker = null;
    },
    getStart() {
      if (!marker) return null;
      const { lat, lng } = marker.getLatLng();
      return { lat, lon: lng };
    },
    setStart(start) {
      placeStart(L.latLng(start.lat, start.lon));
      map.setView([start.lat, start.lon], Math.max(map.getZoom(), 13));
    },
    setRadius(meters: number) {
      radiusMeters = meters;
      circle?.setRadius(meters);
    },
    onStartChange(cb) {
      changeCb = cb;
    },
  };
}
