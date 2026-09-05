// geo.ts — geolocation watcher with last-known-fix caching.

export interface Fix {
  lat: number;
  lon: number;
  accuracyM: number;
  t: number;
}

export class GeoWatcher {
  private watchId: number | null = null;
  public last: Fix | null = null;
  public error: string | null = null;

  start(): void {
    if (!("geolocation" in navigator)) {
      this.error = "geolocation unsupported";
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.last = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          t: pos.timestamp / 1000,
        };
        this.error = null;
      },
      (err) => {
        this.error = err.message;
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }
}
