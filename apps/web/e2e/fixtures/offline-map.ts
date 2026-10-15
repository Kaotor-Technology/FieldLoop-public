import type { Page } from "@playwright/test";

// Replace only the paid basemap API. The production GoogleMapsOverlay and deck.gl
// layers still render into their real WebGL canvas in these offline browser tests.
export async function installOfflineMap(page: Page) {
  await page.addInitScript(() => {
    class LatLng {
      constructor(private latitude: number, private longitude: number) {}
      lat() { return this.latitude; }
      lng() { return this.longitude; }
    }
    class Point { constructor(public x: number, public y: number) {} }
    class OfflineMap {
      private center: LatLng;
      private zoom: number;
      private listeners = new Map<string, Set<() => void>>();
      constructor(private element: HTMLElement, options: { center: { lat: number; lng: number }; zoom: number }) {
        this.center = new LatLng(options.center.lat, options.center.lng);
        this.zoom = options.zoom;
        const pane = document.createElement("div");
        Object.assign(pane.style, { position: "absolute", inset: "0" });
        element.appendChild(pane);
      }
      getDiv() { return this.element; }
      getCenter() { return this.center; }
      getZoom() { return this.zoom; }
      getHeading() { return 0; }
      getTilt() { return 0; }
      getRenderingType() { return "RASTER"; }
      getBounds() {
        return { getSouthWest: () => new LatLng(13.72, 100.52), getNorthEast: () => new LatLng(13.83, 100.64) };
      }
      addListener(name: string, listener: () => void) {
        const listeners = this.listeners.get(name) ?? new Set();
        listeners.add(listener); this.listeners.set(name, listeners);
        return { remove: () => listeners.delete(listener) };
      }
      moveCamera(options: { center?: { lat: number; lng: number }; zoom?: number }) {
        if (options.center) this.center = new LatLng(options.center.lat, options.center.lng);
        if (options.zoom !== undefined) this.zoom = options.zoom;
        this.listeners.get("idle")?.forEach((listener) => listener());
      }
      setZoom(zoom: number) { this.moveCamera({ zoom }); }
    }
    class OverlayView {
      private map: OfflineMap | null = null;
      private resizeObserver: ResizeObserver | null = null;
      onAdd = () => undefined;
      onRemove = () => undefined;
      draw = () => undefined;
      setMap(map: OfflineMap | null) {
        this.resizeObserver?.disconnect();
        this.map = map;
        if (map) {
          this.onAdd(); this.draw();
          this.resizeObserver = new ResizeObserver(() => this.draw());
          this.resizeObserver.observe(map.getDiv());
        } else this.onRemove();
      }
      getMap() { return this.map; }
      getPanes() { return { overlayLayer: this.map?.getDiv().firstElementChild }; }
      getProjection() {
        const map = this.map;
        if (!map) throw new Error("Offline map is detached");
        const scale = 256 * 2 ** map.getZoom();
        const mercatorY = (lat: number) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
        const center = map.getCenter();
        const toPixel = (point: LatLng) => new Point(
          (point.lng() - center.lng()) / 360 * scale + map.getDiv().clientWidth / 2,
          (mercatorY(point.lat()) - mercatorY(center.lat())) * scale + map.getDiv().clientHeight / 2,
        );
        return {
          fromLatLngToDivPixel: toPixel,
          fromLatLngToContainerPixel: toPixel,
          fromContainerPixelToLatLng: (point: Point) => new LatLng(
            Math.atan(Math.sinh(Math.PI * (1 - 2 * (mercatorY(center.lat()) + (point.y - map.getDiv().clientHeight / 2) / scale)))) * 180 / Math.PI,
            center.lng() + (point.x - map.getDiv().clientWidth / 2) / scale * 360,
          ),
        };
      }
    }
    Object.assign(window, { google: { maps: {
      importLibrary: async () => ({ Map: OfflineMap }),
      RenderingType: { RASTER: "RASTER", VECTOR: "VECTOR", UNINITIALIZED: "UNINITIALIZED" },
      OverlayView, LatLng, Point,
    } } });
  });
  await page.route("**/api/v1/map/config", (route) => route.fulfill({ json: { mapsApiKey: "offline-browser-fixture" } }));
}
