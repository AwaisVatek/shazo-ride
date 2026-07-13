import { Router, Request, Response } from "express";
import { requireAuth, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { config } from "../../config/index";
import { db } from "../../db/index";

const router = Router();

function verifyMapsKey(res: Response): boolean {
  const key = config.MAPS_API_KEY;
  if (!key || key === "YOUR_FRONTEND_MAPS_KEY" || key === "demo_maps_api_key_public") {
    sendError(res, "MAPS_API_KEY_MISSING", "Google Maps API Key is missing or unconfigured.", 400);
    return false;
  }
  return true;
}

const NOMINATIM_BASE = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
const OSRM_BASE = process.env.OSRM_URL || "http://router.project-osrm.org";

function verifyGeocodingKey(res: Response): boolean {
  return true; // Deprecated, we use Nominatim now
}

router.get("/autocomplete", requireAuth, async (req: Request, res: Response) => {
  const query = req.query.query as string;
  if (!query) {
    return sendError(res, "VALIDATION_FAILED", "Please specify a query string.");
  }

  try {
    const cacheKey = `autocomplete:${query.toLowerCase().trim()}`;
    let cached: any[] = [];
    try {
      cached = await db.query("SELECT response_json FROM places_cache WHERE query = $1", [cacheKey]);
    } catch(e) {}
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json&viewbox=66.82,25.18,67.42,24.73&bounded=1&limit=5`;
    const apiResponse = await fetch(url, { headers: { 'User-Agent': 'ShazoRideApp/1.0' } });
    if (!apiResponse.ok) {
      throw new Error(`Nominatim Autocomplete failed with status code ${apiResponse.status}`);
    }

    const body: any = await apiResponse.json();

    const predictions = body.map((item: any) => ({
      place_id: item.place_id.toString(),
      description: item.display_name,
      geometry: {
        location: {
          lat: parseFloat(item.lat),
          lng: parseFloat(item.lon)
        }
      },
      structured_formatting: {
        main_text: item.name,
        secondary_text: item.display_name.replace(item.name + ', ', '')
      }
    }));

    await db.query(
      `INSERT INTO places_cache (query, response_json) VALUES ($1, $2)
       ON CONFLICT (query) DO UPDATE SET response_json = EXCLUDED.response_json`,
      [cacheKey, JSON.stringify(predictions)]
    ).catch(() => {});

    return sendSuccess(res, predictions);
  } catch (err: any) {
    return sendError(res, "AUTOCOMPLETE_ERROR", err.message, 500);
  }
});

router.get("/place-details", requireAuth, async (req: Request, res: Response) => {
  const placeId = req.query.placeId as string;
  if (!placeId) {
    return sendError(res, "VALIDATION_FAILED", "A place_id is mandatory.");
  }

  try {
    const cacheKey = `place_details:${placeId}`;
    let cached: any[] = [];
    try {
      cached = await db.query("SELECT response_json FROM places_cache WHERE query = $1", [cacheKey]);
    } catch(e) {}
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `${NOMINATIM_BASE}/details?place_id=${placeId}&format=json`;
    const apiResponse = await fetch(url, { headers: { 'User-Agent': 'ShazoRideApp/1.0' } });
    if (!apiResponse.ok) {
      throw new Error(`Nominatim Place Details failed with status code ${apiResponse.status}`);
    }

    const body: any = await apiResponse.json();
    const details = {
      place_id: placeId,
      geometry: {
        location: {
          lat: parseFloat(body.centroid?.coordinates?.[1] || 0),
          lng: parseFloat(body.centroid?.coordinates?.[0] || 0)
        }
      }
    };

    await db.query(
      `INSERT INTO places_cache (query, response_json) VALUES ($1, $2)
       ON CONFLICT (query) DO UPDATE SET response_json = EXCLUDED.response_json`,
      [cacheKey, JSON.stringify(details)]
    ).catch(() => {});

    return sendSuccess(res, details);
  } catch (err: any) {
    return sendError(res, "PLACE_DETAILS_ERROR", err.message, 500);
  }
});

router.post("/geocode", requireAuth, async (req: Request, res: Response) => {
  const { address } = req.body;
  if (!address) {
    return sendError(res, "VALIDATION_FAILED", "Please provide a physical address.");
  }

  try {
    const cacheKey = `geocode:${address.toLowerCase().trim()}`;
    let cached: any[] = [];
    try {
      cached = await db.query("SELECT response_json FROM geocode_cache WHERE address_or_coords = $1", [cacheKey]);
    } catch(e) {}
    
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
    const response = await fetch(url, { headers: { 'User-Agent': 'ShazoRideApp/1.0' } });
    if (!response.ok) {
      throw new Error(`Nominatim Geocoding failed with status code ${response.status}`);
    }

    const body: any = await response.json();
    if (!body || body.length === 0) {
      return sendError(res, "ADDRESS_NOT_FOUND", "Could not locate the coordinates for this address.", 404);
    }

    const r = body[0];
    const output = {
      address: r.display_name,
      latitude: parseFloat(r.lat),
      longitude: parseFloat(r.lon)
    };

    await db.query(
      `INSERT INTO geocode_cache (address_or_coords, response_json) VALUES ($1, $2)
       ON CONFLICT (address_or_coords) DO UPDATE SET response_json = EXCLUDED.response_json`,
      [cacheKey, JSON.stringify(output)]
    ).catch(() => {});

    return sendSuccess(res, output);
  } catch (err: any) {
    return sendError(res, "GEOCODE_ERROR", err.message, 500);
  }
});

router.post("/reverse-geocode", requireAuth, async (req: Request, res: Response) => {
  const { latitude, longitude } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return sendError(res, "VALIDATION_FAILED", "Both latitude and longitude are needed.");
  }

  const coordStr = `${latitude},${longitude}`;

  try {
    let cached: any[] = [];
    try {
      cached = await db.query("SELECT response_json FROM geocode_cache WHERE address_or_coords = $1", [coordStr]);
    } catch(e) {}
    
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `${NOMINATIM_BASE}/reverse?lat=${latitude}&lon=${longitude}&format=json`;
    const response = await fetch(url, { headers: { 'User-Agent': 'ShazoRideApp/1.0' } });
    if (!response.ok) {
      throw new Error(`Nominatim Reverse Geocoding failed with status code ${response.status}`);
    }

    const body: any = await response.json();
    if (body.error) {
      return sendError(res, "ADDRESS_NOT_FOUND", "Could not resolve address elements for these coordinates.", 404);
    }

    const output = {
      address: body.display_name,
      latitude,
      longitude
    };

    await db.query(
      `INSERT INTO geocode_cache (address_or_coords, response_json) VALUES ($1, $2)
       ON CONFLICT (address_or_coords) DO UPDATE SET response_json = EXCLUDED.response_json`,
      [coordStr, JSON.stringify(output)]
    ).catch(() => {});

    return sendSuccess(res, output);
  } catch (err: any) {
    return sendError(res, "REVERSE_GEOCODE_ERROR", err.message, 500);
  }
});

router.post("/distance", requireAuth, async (req: Request, res: Response) => {
  const { origin_lat, origin_lng, dest_lat, dest_lng } = req.body;
  if ([origin_lat, origin_lng, dest_lat, dest_lng].some(v => v === undefined)) {
    return sendError(res, "VALIDATION_FAILED", "Please supply coordinates for both source and destination.");
  }

  const cacheKey = `dist:${origin_lat},${origin_lng}_to_${dest_lat},${dest_lng}`;

  try {
    let cached: any[] = [];
    try {
      cached = await db.query("SELECT response_json FROM route_cache WHERE origin_destination = $1", [cacheKey]);
    } catch(e) {}
    
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `${OSRM_BASE}/route/v1/driving/${origin_lng},${origin_lat};${dest_lng},${dest_lat}?overview=false`;
    const response = await fetch(url, { headers: { 'User-Agent': 'ShazoRideApp/1.0' } });
    if (!response.ok) {
      throw new Error(`OSRM Routing failed with status code ${response.status}`);
    }

    const body: any = await response.json();
    if (body.code !== "Ok" || !body.routes || body.routes.length === 0) {
      return sendError(res, "ROUTE_NOT_FOUND", "Could not calculate route for these locations.", 404);
    }

    const route = body.routes[0];
    const durationMin = Math.ceil(route.duration / 60);
    const distanceKm = +(route.distance / 1000).toFixed(2);

    const output = {
      distance: { text: `${distanceKm} km`, value: route.distance },
      duration: { text: `${durationMin} mins`, value: route.duration }
    };

    await db.query(
      `INSERT INTO route_cache (origin_destination, response_json) VALUES ($1, $2)
       ON CONFLICT (origin_destination) DO UPDATE SET response_json = EXCLUDED.response_json`,
      [cacheKey, JSON.stringify(output)]
    ).catch(() => {});

    return sendSuccess(res, output);
  } catch (err: any) {
    return sendError(res, "DISTANCE_MATRIX_ERROR", err.message, 500);
  }
});

router.post("/place-autocomplete", requireAuth, async (req: Request, res: Response) => {
  const { address } = req.body;
  if (!address) return sendError(res, "VALIDATION_FAILED", "Address needed.");

  try {
    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(address)}&format=json&limit=5`;
    const apiResponse = await fetch(url, { headers: { 'User-Agent': 'ShazoRideApp/1.0' } });
    if (!apiResponse.ok) throw new Error("Failed");
    const body: any = await apiResponse.json();
    
    return sendSuccess(res, body.map((i: any) => ({
      address: i.display_name,
      lat: parseFloat(i.lat),
      lng: parseFloat(i.lon)
    })));
  } catch (err: any) {
    return sendError(res, "AUTOCOMPLETE_ERROR", err.message, 500);
  }
});

export default router;
