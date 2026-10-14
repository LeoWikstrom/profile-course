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

  map.on('click', (e: L.LeafletMouseEvent) => placeStart(e.latlng));

  let courseLayer: L.LayerGroup | null = null;
  let pointMarker: L.CircleMarker | null = null;

  return {
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
      pointMarker?.remove();
      pointMarker = null;
    },
    showCoursePoint(point) {
      if (!pointMarker) {
        pointMarker = L.circleMarker([point.lat, point.lon], {
          radius: 7,
          color: '#dc2626',
          weight: 3,
          fillColor: '#fff',
          fillOpacity: 1,
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
