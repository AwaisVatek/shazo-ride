import { config } from "../config/index";

const MAPBOX_DIRECTIONS_BASE = "https://api.mapbox.com/directions/v5/mapbox/driving";

/**
 * Computes a live driving ETA in whole minutes between two points via the
 * Mapbox Directions API. Returns null on any failure so callers can degrade
 * gracefully (e.g. omit the ETA from a socket payload rather than blocking it).
 */
export async function computeEtaMinutes(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<number | null> {
  const route = await computeRoute(originLat, originLng, destLat, destLng);
  return route ? route.etaMinutes : null;
}

/**
 * Computes live driving distance (km) and ETA (whole minutes) in one Mapbox
 * Directions call. Returns null on any failure — callers should fall back to
 * a flat estimate.
 */
export async function computeRoute(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<{ distanceKm: number; etaMinutes: number } | null> {
  try {
    const url = `${MAPBOX_DIRECTIONS_BASE}/${originLng},${originLat};${destLng},${destLat}?access_token=${config.MAPBOX_API_KEY}&overview=false`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const body: any = await response.json();
    if (body.code !== "Ok" || !body.routes || body.routes.length === 0) return null;

    const route = body.routes[0];
    return {
      distanceKm: +(route.distance / 1000).toFixed(2),
      etaMinutes: Math.ceil(route.duration / 60),
    };
  } catch {
    return null;
  }
}
