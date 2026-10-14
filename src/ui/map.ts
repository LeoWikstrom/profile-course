import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import type { LatLon } from '../shared/messages';

L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

export interface MapController {
  getStart(): LatLon | null;
  setRadius(meters: number): void;
  onStartChange(cb: (start: LatLon) => void): void;
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

  return {
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
