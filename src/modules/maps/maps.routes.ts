import { Router, Request, Response } from "express";
import { requireAuth, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { config } from "../../config/index";
import { db } from "../../db/index";

const router = Router();

/**
 * Checks if the front-end Maps key is configured.
 * If missing, returns MAPS_API_KEY_MISSING.
 */
function verifyMapsKey(res: Response): boolean {
  const key = config.MAPS_API_KEY;
  if (!key || key === "YOUR_FRONTEND_MAPS_KEY" || key === "demo_maps_api_key_public") {
    sendError(res, "MAPS_API_KEY_MISSING", "Google Maps API Key is missing or unconfigured.", 400);
    return false;
  }
  return true;
}

/**
 * Checks if the back-end Geocoding key is configured.
 * If missing, returns MAPS_API_KEY_MISSING.
 */
function verifyGeocodingKey(res: Response): boolean {
  const key = config.GEOCODING_API_KEY;
  if (!key || key === "YOUR_BACKEND_GEOCODING_KEY" || key === "demo_maps_geocoding_key_backend") {
    sendError(res, "MAPS_API_KEY_MISSING", "Google Geocoding API Key is missing or unconfigured.", 400);
    return false;
  }
  return true;
}

/**
 * GET /api/maps/autocomplete
 * Search places by text query
 */
router.get("/autocomplete", requireAuth, async (req: Request, res: Response) => {
  if (!verifyMapsKey(res)) return;

  const query = req.query.query as string;
  if (!query) {
    return sendError(res, "VALIDATION_FAILED", "Please specify a query string.");
  }

  try {
    const cacheKey = `autocomplete:${query.toLowerCase().trim()}`;
    const cached = await db.query("SELECT response_json FROM places_cache WHERE query = $1", [cacheKey]);
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&components=country:pk&key=${config.MAPS_API_KEY}`;
    const apiResponse = await fetch(url);
    if (!apiResponse.ok) {
      throw new Error(`Google Places Autocomplete failed with status code ${apiResponse.status}`);
    }

    const body: any = await apiResponse.json();
    if (body.status === "REQUEST_DENIED") {
      return sendError(res, "MAPS_API_KEY_MISSING", "Google Maps API Key is invalid or restricted.", 400);
    }

    const predictions = body.predictions || [];

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

/**
 * GET /api/maps/place-details
 * Retrieve detailed geometry for a specific place_id
 */
router.get("/place-details", requireAuth, async (req: Request, res: Response) => {
  if (!verifyMapsKey(res)) return;

  const placeId = req.query.placeId as string;
  if (!placeId) {
    return sendError(res, "VALIDATION_FAILED", "A place_id is mandatory.");
  }

  try {
    const cacheKey = `place_details:${placeId}`;
    const cached = await db.query("SELECT response_json FROM places_cache WHERE query = $1", [cacheKey]);
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&key=${config.MAPS_API_KEY}`;
    const apiResponse = await fetch(url);
    if (!apiResponse.ok) {
      throw new Error(`Google Place Details failed with status code ${apiResponse.status}`);
    }

    const body: any = await apiResponse.json();
    if (body.status === "REQUEST_DENIED") {
      return sendError(res, "MAPS_API_KEY_MISSING", "Google Maps API Key is invalid or restricted.", 400);
    }

    const result = body.result;
    if (!result) {
      return sendError(res, "PLACE_NOT_FOUND", "The requested place_id details could not be found.", 404);
    }

    const loc = result.geometry?.location;
    if (!loc) {
      return sendError(res, "PLACE_GEOMETRY_MISSING", "No latitude or longitude geometry returned for this place.", 400);
    }

    const details = {
      address: result.formatted_address,
      latitude: loc.lat,
      longitude: loc.lng,
      place_id: placeId
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

/**
 * POST /api/maps/geocode
 * Get coordinates by address
 */
router.post("/geocode", requireAuth, async (req: Request, res: Response) => {
  if (!verifyGeocodingKey(res)) return;

  const { address } = req.body;
  if (!address) {
    return sendError(res, "VALIDATION_FAILED", "Please provide a physical address.");
  }

  try {
    const cacheKey = `geocode:${address.toLowerCase().trim()}`;
    const cached = await db.query("SELECT response_json FROM geocode_cache WHERE address_or_coords = $1", [cacheKey]);
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${config.GEOCODING_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google Geocoding failed with status code ${response.status}`);
    }

    const body: any = await response.json();
    if (body.status === "REQUEST_DENIED") {
      return sendError(res, "MAPS_API_KEY_MISSING", "Google Geocoding API Key is invalid or restricted.", 400);
    }

    const r = body.results?.[0];
    if (!r) {
      return sendError(res, "ADDRESS_NOT_FOUND", "Could not locate the coordinates for this address.", 404);
    }

    const loc = r.geometry?.location;
    const output = {
      address: r.formatted_address,
      latitude: loc.lat,
      longitude: loc.lng
    };

    await db.query(
      `INSERT INTO geocode_cache (address_or_coords, response_json) VALUES ($1, $2)
       ON CONFLICT (address_or_coords) DO UPDATE SET response_json = EXCLUDED.response_json`,
      [address, JSON.stringify(output)]
    ).catch(() => {});

    return sendSuccess(res, output);
  } catch (err: any) {
    return sendError(res, "GEOCODE_ERROR", err.message, 500);
  }
});

/**
 * POST /api/maps/reverse-geocode
 * Resolve physical address from coordinates
 */
router.post("/reverse-geocode", requireAuth, async (req: Request, res: Response) => {
  if (!verifyGeocodingKey(res)) return;

  const { latitude, longitude } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return sendError(res, "VALIDATION_FAILED", "Both latitude and longitude are needed.");
  }

  const coordStr = `${latitude},${longitude}`;

  try {
    const cached = await db.query("SELECT response_json FROM geocode_cache WHERE address_or_coords = $1", [coordStr]);
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${coordStr}&key=${config.GEOCODING_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google Reverse Geocoding failed with status code ${response.status}`);
    }

    const body: any = await response.json();
    if (body.status === "REQUEST_DENIED") {
      return sendError(res, "MAPS_API_KEY_MISSING", "Google Geocoding API Key is invalid or restricted.", 400);
    }

    const r = body.results?.[0];
    if (!r) {
      return sendError(res, "ADDRESS_NOT_FOUND", "Could not resolve address elements for these coordinates.", 404);
    }

    const output = {
      address: r.formatted_address,
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

/**
 * POST /api/maps/distance
 * Evaluates distances and duration parameters between coordinates using standard Google Distance Matrix
 */
router.post("/distance", requireAuth, async (req: Request, res: Response) => {
  if (!verifyMapsKey(res)) return;

  const { origin_lat, origin_lng, dest_lat, dest_lng } = req.body;
  if ([origin_lat, origin_lng, dest_lat, dest_lng].some(v => v === undefined)) {
    return sendError(res, "VALIDATION_FAILED", "Please supply coordinates for both source and destination.");
  }

  const cacheKey = `dist:${origin_lat},${origin_lng}_to_${dest_lat},${dest_lng}`;

  try {
    const cached = await db.query("SELECT response_json FROM route_cache WHERE origin_destination = $1", [cacheKey]);
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin_lat},${origin_lng}&destinations=${dest_lat},${dest_lng}&key=${config.MAPS_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google Distance Matrix failed with status code ${response.status}`);
    }

    const body: any = await response.json();
    if (body.status === "REQUEST_DENIED") {
      return sendError(res, "MAPS_API_KEY_MISSING", "Google Maps API Key is invalid or restricted.", 400);
    }

    const row = body.rows?.[0];
    const element = row?.elements?.[0];
    if (!element || element.status !== "OK") {
      return sendError(res, "ROUTE_NOT_FOUND", "Google could not calculate a road route distance between these points.", 400);
    }

    const distance_km = Number((element.distance.value / 1000).toFixed(2));
    const duration_minutes = Math.round(element.duration.value / 60);

    const details = {
      distance_km,
      duration_minutes: duration_minutes < 1 ? 1 : duration_minutes,
    };

    await db.query(
      `INSERT INTO route_cache (origin_destination, response_json) VALUES ($1, $2)
       ON CONFLICT (origin_destination) DO UPDATE SET response_json = EXCLUDED.response_json`,
      [cacheKey, JSON.stringify(details)]
    ).catch(() => {});

    return sendSuccess(res, details);
  } catch (err: any) {
    return sendError(res, "DISTANCE_MATRIX_ERROR", err.message, 500);
  }
});

/**
 * POST /api/maps/directions
 * Fetch directions route geometries and instructions
 */
router.post("/directions", requireAuth, async (req: Request, res: Response) => {
  if (!verifyMapsKey(res)) return;

  const { origin_lat, origin_lng, dest_lat, dest_lng } = req.body;
  if ([origin_lat, origin_lng, dest_lat, dest_lng].some(v => v === undefined)) {
    return sendError(res, "VALIDATION_FAILED", "Incomplete route parameters.");
  }

  const cacheKey = `directions:${origin_lat},${origin_lng}_to_${dest_lat},${dest_lng}`;

  try {
    const cached = await db.query("SELECT response_json FROM route_cache WHERE origin_destination = $1", [cacheKey]);
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin_lat},${origin_lng}&destination=${dest_lat},${dest_lng}&key=${config.MAPS_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google Directions failed with status code ${response.status}`);
    }

    const body: any = await response.json();
    if (body.status === "REQUEST_DENIED") {
      return sendError(res, "MAPS_API_KEY_MISSING", "Google Maps API Key is invalid or restricted.", 400);
    }

    const route = body.routes?.[0];
    if (!route) {
      return sendError(res, "ROUTE_NOT_FOUND", "No route directions could be calculated between these coordinates.", 400);
    }

    const leg = route.legs?.[0];
    const routeInfo = {
      distance_km: Number(((leg?.distance?.value || 0) / 1000).toFixed(2)),
      duration_minutes: Math.max(1, Math.round((leg?.duration?.value || 0) / 60)),
      encoded_polyline: route.overview_polyline?.points || "",
      bounds: route.bounds || {
        northeast: { lat: Math.max(origin_lat, dest_lat), lng: Math.max(origin_lng, dest_lng) },
        southwest: { lat: Math.min(origin_lat, dest_lat), lng: Math.min(origin_lng, dest_lng) }
      }
    };

    await db.query(
      `INSERT INTO route_cache (origin_destination, response_json) VALUES ($1, $2)
       ON CONFLICT (origin_destination) DO UPDATE SET response_json = EXCLUDED.response_json`,
      [cacheKey, JSON.stringify(routeInfo)]
    ).catch(() => {});

    return sendSuccess(res, routeInfo);
  } catch (err: any) {
    return sendError(res, "DIRECTIONS_ROUTE_ERROR", err.message, 500);
  }
});

/**
 * POST /api/maps/route-preview
 * Route preview forwarder
 */
router.post("/route-preview", requireAuth, async (req: Request, res: Response) => {
  return res.redirect(307, "/api/maps/directions");
});

/**
 * POST /api/maps/coverage-check
 * Check if coordinate coordinates lie within active Karachi service zone limits
 */
router.post("/coverage-check", requireAuth, async (req: Request, res: Response) => {
  const { latitude, longitude } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return sendError(res, "VALIDATION_FAILED", "Please provide coordinates to evaluate limits.");
  }

  // Karachi service boundaries verification: approx Lat: 24.73 to 25.18, Lng: 66.82 to 67.42
  const isCovered = (latitude >= 24.73 && latitude <= 25.18) && (longitude >= 66.82 && longitude <= 67.42);

  return sendSuccess(res, {
    covered: isCovered,
    city: config.DEFAULT_CITY,
    message: isCovered ? "Coordinate is located within Shazo operational bounds." : "Outside current operational limits."
  });
});

/**
 * GET /api/maps/zones
 * Fetch coordinates polygon definitions for Karachi zones
 */
router.get("/zones", requireAuth, async (req: Request, res: Response) => {
  try {
    const zones = await db.query("SELECT * FROM city_zones WHERE is_active = true");
    return sendSuccess(res, { zones });
  } catch (err: any) {
    return sendError(res, "FETCH_ZONES_FAILED", err.message, 500);
  }
});

/**
 * GET /api/maps/nearby-riders
 * Scans active online verified pilots
 */
router.get("/nearby-riders", requireAuth, async (req: Request, res: Response) => {
  const { latitude, longitude, radius_km = 5 } = req.query;

  if (!latitude || !longitude) {
    return sendError(res, "VALIDATION_FAILED", "Origin coordinates are required to query nearby drivers.");
  }

  const latNum = Number(latitude);
  const lngNum = Number(longitude);
  const radNum = Number(radius_km);

  try {
    const activeRiders = await db.query(
      `SELECT rp.user_id, u.full_name, u.phone, COALESCE(rv.vehicle_category, rp.vehicle_type) AS vehicle_type, rp.latitude, rp.longitude,
              (6371 * acos(cos(radians($1)) * cos(radians(rp.latitude)) * cos(radians(rp.longitude) - radians($2)) + sin(radians($3)) * sin(radians(rp.latitude)))) AS distance_km
       FROM rider_profiles rp
       JOIN users u ON rp.user_id = u.id
       LEFT JOIN rider_vehicles rv ON rv.rider_id = rp.user_id
       WHERE rp.is_online = true AND rp.verification_status = 'verified'
       ORDER BY distance_km ASC`,
      [latNum, lngNum, latNum]
    );

    const localRiders = activeRiders.filter(r => Number(r.distance_km) <= radNum);
    return sendSuccess(res, { riders: localRiders });
  } catch (err: any) {
    return sendError(res, "NEARBY_RIDER_SEARCH_FAILED", err.message, 500);
  }
});

/**
 * POST /api/rider/location
 * Streams last active location coordinate of a pilot
 */
router.post("/location", requireAuth, async (req: Request, res: Response) => {
  const { latitude, longitude } = req.body;
  const authReq = req as AuthenticatedRequest;

  if (authReq.user!.role !== "rider") {
    return sendError(res, "FORBIDDEN", "Only verified pilots can stream tracking coordinates.", 403);
  }

  if (latitude === undefined || longitude === undefined) {
    return sendError(res, "VALIDATION_FAILED", "Please provide correct coordinates.");
  }

  try {
    await db.query(
      `UPDATE rider_profiles 
       SET latitude = $1, longitude = $2, last_location_update = NOW()
       WHERE user_id = $3`,
      [latitude, longitude, authReq.user!.id]
    );

    // Save history track in rider_locations too, if matching is required
    await db.query(
      `INSERT INTO rider_locations (user_id, latitude, longitude, is_online, updated_at)
       VALUES ($1, $2, $3, true, NOW())
       ON CONFLICT (user_id) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, updated_at = NOW()`,
      [authReq.user!.id, latitude, longitude]
    );

    return sendSuccess(res, { message: "Rider location coordinate synchronized." });
  } catch (err: any) {
    return sendError(res, "RIDER_LOCATION_SYNC_FAILED", err.message, 500);
  }
});

/**
 * GET /api/rides/:id/live-location
 * Streams latest available driver location details on a ride
 */
router.get("/rides/:id/live-location", requireAuth, async (req: Request, res: Response) => {
  const rideId = req.params.id;

  try {
    const rides = await db.query("SELECT rider_id, status FROM ride_bookings WHERE id = $1", [rideId]);
    if (rides.length === 0) {
      return sendError(res, "RIDE_NOT_FOUND", "Encountered invalid ride ID mapping.", 404);
    }

    const { rider_id, status } = rides[0];
    if (!rider_id) {
      return sendSuccess(res, { status, driver_coordinates: null, message: "Driver has not been assigned to this booking yet." });
    }

    const coords = await db.query(
      `SELECT latitude, longitude, last_location_update 
       FROM rider_profiles WHERE user_id = $1`,
      [rider_id]
    );

    if (coords.length === 0 || !coords[0].latitude) {
      return sendSuccess(res, { status, driver_coordinates: null });
    }

    return sendSuccess(res, {
      status,
      driver_coordinates: {
        latitude: Number(coords[0].latitude),
        longitude: Number(coords[0].longitude),
        last_updated: coords[0].last_location_update
      }
    });
  } catch (err: any) {
    return sendError(res, "LIVE_LOCATION_TRACKING_FAILED", err.message, 500);
  }
});

export default router;
