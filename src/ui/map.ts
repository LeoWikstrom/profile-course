import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import type { CourseSegment, LatLon } from '../shared/messages';

const SURFACE_COLORS = ['#2563eb', '#d97706', '#16a34a', '#6b7280'];

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
  setRadius(meters: number): void;
  onStartChange(cb: (start: LatLon) => void): void;
  drawCourse(segments: CourseSegment[], options?: { faded?: boolean }): void;
  clearCourse(): void;
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
    clearCourse() {
      courseLayer?.remove();
      courseLayer = null;
    },
    getStart() {
      if (!marker) return null;
      const { lat, lng } = marker.getLatLng();
      return { lat, lon: lng };
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
