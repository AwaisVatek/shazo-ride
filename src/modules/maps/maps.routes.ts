import { Router, Request, Response } from "express";
import { requireAuth, requireOperationsManager } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { config } from "../../config/index";
import { db } from "../../db/index";

const router = Router();

// Mapbox is this platform's only maps/geocoding/routing provider — no Google Maps.
const MAPBOX_GEOCODING_BASE = "https://api.mapbox.com/geocoding/v5/mapbox.places";
const MAPBOX_DIRECTIONS_BASE = "https://api.mapbox.com/directions/v5/mapbox/driving";
// Karachi bounding box (minLon,minLat,maxLon,maxLat) — biases search results locally.
const KARACHI_BBOX = "66.82,24.73,67.42,25.18";

function verifyMapboxKey(res: Response): boolean {
  const key = config.MAPBOX_API_KEY;
  if (!key || key === "demo_mapbox_secret_key") {
    sendError(res, "MAPBOX_API_KEY_MISSING", "Mapbox API key is missing or unconfigured.", 400);
    return false;
  }
  return true;
}

// Mapbox's raw place_name is the full administrative chain ("Gulshan-E-
// Iqbal, Karachi, Karachi East, Sindh, Pakistan") and, without an explicit
// language, mixes in Urdu-script admin names (confirmed live: a district
// came back as "کراچی مشرقی" instead of "Karachi East") — both are fixed
// by requesting &language=en on every Mapbox geocoding call and normalizing
// down to the specific place name plus at most one area-level qualifier,
// never region/country/district.
function normalizeMapboxAddress(feature: any): string {
  const primary: string = feature.text;
  const placeType = feature.place_type?.[0];

  // The feature itself is already an area-level name (a neighborhood, a
  // locality, or a city-scale "place") — that's exactly the specificity
  // wanted (e.g. "Bahadurabad", "Gulshan-E-Iqbal"); no admin suffix needed.
  if (["neighborhood", "locality", "place"].includes(placeType)) {
    return primary;
  }

  // A narrower feature (a POI or a street address) gets one level of area
  // context for clarity — never a district/region/country.
  const context = Array.isArray(feature.context) ? feature.context : [];
  const areaContext = context.find((c: any) =>
    typeof c.id === "string" &&
    (c.id.startsWith("neighborhood.") || c.id.startsWith("locality.") || c.id.startsWith("place."))
  );
  if (areaContext?.text && areaContext.text !== primary) {
    return `${primary}, ${areaContext.text}`;
  }
  return primary;
}

// Unnamed "addresses"-category rows had their `name` synthesized directly
// from address components at import time (see import-karachi-landmarks.ts),
// so `name` and `address` are often identical or one a prefix of the other.
// Naively joining them ("X, X, Karachi") produced visibly duplicated text —
// confirmed live against a real coordinate. Collapse to whichever of the two
// is the more complete string instead of always concatenating both.
function combineNameAndAddress(name: string, address: string | null | undefined): string {
  if (!address) return name;
  const n = name.trim().toLowerCase();
  const a = address.trim().toLowerCase();
  if (a === n || a.startsWith(n)) return address;
  if (n.startsWith(a)) return name;
  return `${name}, ${address}`;
}

function toPrediction(feature: any) {
  const secondary = typeof feature.place_name === "string" && typeof feature.text === "string"
    ? feature.place_name.replace(feature.text + ", ", "")
    : feature.place_name;

  return {
    place_id: feature.id,
    description: feature.place_name,
    geometry: {
      location: {
        lat: feature.center?.[1],
        lng: feature.center?.[0]
      }
    },
    structured_formatting: {
      main_text: feature.text,
      secondary_text: secondary
    }
  };
}

// Karachi center — used as a proximity-bias fallback when the caller doesn't
// have a live GPS fix yet (e.g. location permission still pending).
const KARACHI_CENTER = { lat: 24.8607, lng: 67.0011 };

function toLandmarkPrediction(row: any) {
  return {
    place_id: row.id,
    description: combineNameAndAddress(row.name, row.address),
    geometry: { location: { lat: Number(row.lat), lng: Number(row.lng) } },
    structured_formatting: {
      main_text: row.name,
      secondary_text: row.address || "Karachi"
    },
    source: "landmark"
  };
}

// Mapbox's own POI/landmark index was verified to have almost no coverage for
// Karachi (malls, hospitals, even large neighborhoods return nothing or
// wrong-country results) — this checks our own `landmarks` table (seeded from
// OpenStreetMap + a comprehensive local pakistan-latest.osm.pbf extract, see
// import-karachi-landmarks.ts) first, before falling back to Mapbox.
//
// The extract's own categorization doesn't tag things like shopping malls
// under "landmarks" (they land in the generic "addresses" bucket instead,
// same as any nearby shop that mentions the mall's name) — so a plain
// alphabetical sort buried the actual "Dolmen Mall" entry under unrelated
// shops like "1st Step Dolmen Mall". Ranking now prefers an exact/prefix name
// match and non-address categories before falling back to proximity/name.
async function searchLocalLandmarks(query: string, lat?: number, lng?: number): Promise<any[]> {
  const trimmedQuery = query.toLowerCase().trim();
  const words = trimmedQuery.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const conditions: string[] = [];
  const params: any[] = [trimmedQuery, `${trimmedQuery}%`];
  words.forEach((word) => {
    params.push(`%${word}%`);
    const idx = params.length;
    conditions.push(`(LOWER(name) LIKE $${idx} OR LOWER(COALESCE(address, '')) LIKE $${idx})`);
  });

  // Real categories in this dataset (confirmed via information_schema/data):
  // addresses, streets_and_lanes, landmarks, districts_and_zones, hospitals —
  // no separate POI/commercial/university/restaurant buckets exist (OSM
  // tags most of those as `landmarks` already). Ranks landmarks/hospitals
  // (named, specific places) above broad districts/streets, which in turn
  // rank above generic street-address rows — but only as a tie-breaker
  // after exact/prefix name relevance, so "Bahadurabad Chowrangi" still
  // beats an unrelated "addresses" row that merely contains the word.
  const CATEGORY_RANK = `CASE category
    WHEN 'landmarks' THEN 1
    WHEN 'hospitals' THEN 2
    WHEN 'districts_and_zones' THEN 3
    WHEN 'streets_and_lanes' THEN 4
    WHEN 'addresses' THEN 5
    ELSE 6
  END`;

  const hasCoords = lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng);
  let orderBy = `
    (LOWER(name) = $1) DESC,
    (LOWER(name) LIKE $2) DESC,
    ${CATEGORY_RANK} ASC
  `;
  if (hasCoords) {
    params.push(lat, lng);
    orderBy += `, (POWER(lat - $${params.length - 1}, 2) + POWER(lng - $${params.length}, 2)) ASC`;
  } else {
    orderBy += `, name ASC`;
  }

  try {
    return await db.query(
      `SELECT * FROM landmarks WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy} LIMIT 8`,
      params
    );
  } catch (e) {
    return [];
  }
}

router.get("/autocomplete", requireAuth, async (req: Request, res: Response) => {
  const query = req.query.query as string;
  if (!query) {
    return sendError(res, "VALIDATION_FAILED", "Please specify a query string.");
  }
  if (!verifyMapboxKey(res)) return;

  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const hasCoords = !isNaN(lat) && !isNaN(lng);
  const proximity = hasCoords ? `${lng},${lat}` : `${KARACHI_CENTER.lng},${KARACHI_CENTER.lat}`;

  try {
    const localMatches = await searchLocalLandmarks(query, hasCoords ? lat : undefined, hasCoords ? lng : undefined);
    const localPredictions = localMatches.map(toLandmarkPrediction);

    // Cache is keyed by query text only (proximity is a ranking hint, not a
    // filter, so results stay reasonable across nearby callers). Only the
    // Mapbox portion is cached — local landmark matches are a fast indexed
    // query and always run fresh.
    const cacheKey = `autocomplete:${query.toLowerCase().trim()}`;
    let cached: any[] = [];
    try {
      cached = await db.query("SELECT response_json FROM places_cache WHERE query = $1", [cacheKey]);
    } catch (e) {}

    let mapboxPredictions: any[];
    if (cached.length > 0) {
      mapboxPredictions = JSON.parse(cached[0].response_json);
    } else {
      // types=poi,address,place,neighborhood,locality ensures landmarks/POIs
      // aren't crowded out by street/place results; proximity ranks results
      // near the caller (or Karachi center) higher instead of relying on bbox
      // alone; limit raised from 5 to 10 for more landmark coverage.
      const url = `${MAPBOX_GEOCODING_BASE}/${encodeURIComponent(query)}.json?access_token=${config.MAPBOX_API_KEY}&autocomplete=true&limit=10&bbox=${KARACHI_BBOX}&country=pk&proximity=${proximity}&types=poi,address,place,neighborhood,locality&language=en`;
      const apiResponse = await fetch(url);
      if (!apiResponse.ok) {
        throw new Error(`Mapbox Autocomplete failed with status code ${apiResponse.status}`);
      }
      const body: any = await apiResponse.json();
      mapboxPredictions = (body.features || []).map(toPrediction);

      await db.query(
        `INSERT INTO places_cache (query, response_json) VALUES ($1, $2)
         ON CONFLICT (query) DO UPDATE SET response_json = EXCLUDED.response_json`,
        [cacheKey, JSON.stringify(mapboxPredictions)]
      ).catch(() => {});
    }

    // Local landmarks first (curated, more likely to be exactly what's
    // wanted), then Mapbox results — skip any Mapbox result that's basically
    // the same place as a local match already returned (rough dedupe by
    // proximity, ~150m).
    const isDuplicate = (mp: any) => localPredictions.some((lp: any) => {
      const dLat = Math.abs(lp.geometry.location.lat - mp.geometry.location.lat);
      const dLng = Math.abs(lp.geometry.location.lng - mp.geometry.location.lng);
      return dLat < 0.0015 && dLng < 0.0015;
    });
    const combined = [...localPredictions, ...mapboxPredictions.filter((mp) => !isDuplicate(mp))].slice(0, 10);

    return sendSuccess(res, combined);
  } catch (err: any) {
    return sendError(res, "AUTOCOMPLETE_ERROR", err.message, 500);
  }
});

router.get("/place-details", requireAuth, async (req: Request, res: Response) => {
  // Mapbox's Geocoding v5 API has no "retrieve a specific place by id" lookup
  // (that's only available on their newer Search Box API). No current client
  // calls this endpoint — autocomplete already returns full geometry inline —
  // so this stays a clear, honest error rather than a fragile improvised guess.
  return sendError(res, "NOT_SUPPORTED", "Place lookup by id is not supported by the Mapbox Geocoding API. Use the geometry already returned by /autocomplete.", 501);
});

router.post("/geocode", requireAuth, async (req: Request, res: Response) => {
  const { address } = req.body;
  if (!address) {
    return sendError(res, "VALIDATION_FAILED", "Please provide a physical address.");
  }
  if (!verifyMapboxKey(res)) return;

  try {
    const cacheKey = `geocode:${address.toLowerCase().trim()}`;
    let cached: any[] = [];
    try {
      cached = await db.query("SELECT response_json FROM geocode_cache WHERE address_or_coords = $1", [cacheKey]);
    } catch (e) {}
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `${MAPBOX_GEOCODING_BASE}/${encodeURIComponent(address)}.json?access_token=${config.MAPBOX_API_KEY}&limit=1&bbox=${KARACHI_BBOX}&country=pk&proximity=${KARACHI_CENTER.lng},${KARACHI_CENTER.lat}&types=poi,address,place,neighborhood,locality&language=en`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Mapbox Geocoding failed with status code ${response.status}`);
    }

    const body: any = await response.json();
    if (!body.features || body.features.length === 0) {
      return sendError(res, "ADDRESS_NOT_FOUND", "Could not locate the coordinates for this address.", 404);
    }

    const f = body.features[0];
    const output = {
      address: normalizeMapboxAddress(f),
      latitude: f.center[1],
      longitude: f.center[0]
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

// How close a local landmark needs to be to a dropped pin before we trust it
// as "this is what the pin is on", rather than just "the nearest thing we
// happen to have". Tight enough that a genuinely wrong address never wins.
const REVERSE_GEOCODE_RADIUS_METERS = 60;

// Some raw OSM `name` tags in the imported dataset were captured in Urdu
// script rather than English/Romanized text (e.g. a street literally named
// "اسٹریٹ ای" — Urdu for "Street E") — confirmed live. Detects Arabic-script
// text (Urdu uses the Arabic block plus a few Arabic Extended-A letters) so
// such rows can be skipped in favor of a real English name from elsewhere,
// rather than ever surfacing Urdu script into what should be an
// English-normalized address.
const ARABIC_SCRIPT_RE = /[؀-ۿݐ-ݿ]/;

async function findNearestLandmark(lat: number, lng: number): Promise<{ address: string } | null> {
  try {
    const rows = await db.query<any>(
      `SELECT *, (111320 * SQRT(POWER(lat - $1, 2) + POWER((lng - $2) * COS(RADIANS($1)), 2))) AS distance_m
       FROM landmarks
       ORDER BY distance_m ASC
       LIMIT 5`,
      [lat, lng]
    );
    // Pick the nearest candidate with a usable (non-Urdu-script) name AND
    // address within radius — a row can have an English `name` but a
    // Urdu-script `address` (or vice versa), and combineNameAndAddress()
    // below surfaces both, so either field alone leaking through still
    // produced Urdu text in the final result. Skip a closer Urdu-tainted row
    // in favor of a slightly farther, fully-English one, or fall through to
    // Mapbox if none qualify.
    const nearest = rows.find((r: any) => !ARABIC_SCRIPT_RE.test(r.name) && !ARABIC_SCRIPT_RE.test(r.address || ""));
    if (!nearest || Number(nearest.distance_m) > REVERSE_GEOCODE_RADIUS_METERS) return null;
    return { address: combineNameAndAddress(nearest.name, nearest.address) };
  } catch (e) {
    return null;
  }
}

router.post("/reverse-geocode", requireAuth, async (req: Request, res: Response) => {
  const { latitude, longitude } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return sendError(res, "VALIDATION_FAILED", "Both latitude and longitude are needed.");
  }

  const coordStr = `${latitude},${longitude}`;

  try {
    // Our own address/landmark data (137k+ rows from a real Karachi OSM
    // extract) is checked first — Mapbox's reverse geocoding for Karachi
    // tends to resolve to a generic "Karachi, Sindh, Pakistan"-level result
    // rather than the actual street/building under the pin. Only fall back
    // to Mapbox if nothing local is close enough to trust.
    const localMatch = await findNearestLandmark(latitude, longitude);
    if (localMatch) {
      return sendSuccess(res, { address: localMatch.address, latitude, longitude, source: "local" });
    }

    if (!verifyMapboxKey(res)) return;

    let cached: any[] = [];
    try {
      cached = await db.query("SELECT response_json FROM geocode_cache WHERE address_or_coords = $1", [coordStr]);
    } catch (e) {}
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `${MAPBOX_GEOCODING_BASE}/${longitude},${latitude}.json?access_token=${config.MAPBOX_API_KEY}&limit=1&language=en`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Mapbox Reverse Geocoding failed with status code ${response.status}`);
    }

    const body: any = await response.json();
    if (!body.features || body.features.length === 0) {
      return sendError(res, "ADDRESS_NOT_FOUND", "Could not resolve address elements for these coordinates.", 404);
    }

    const output = {
      address: normalizeMapboxAddress(body.features[0]),
      latitude,
      longitude,
      source: "mapbox"
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
  if (!verifyMapboxKey(res)) return;

  const cacheKey = `dist:${origin_lat},${origin_lng}_to_${dest_lat},${dest_lng}`;

  try {
    let cached: any[] = [];
    try {
      cached = await db.query("SELECT response_json FROM route_cache WHERE origin_destination = $1", [cacheKey]);
    } catch (e) {}
    if (cached.length > 0) {
      return sendSuccess(res, JSON.parse(cached[0].response_json));
    }

    const url = `${MAPBOX_DIRECTIONS_BASE}/${origin_lng},${origin_lat};${dest_lng},${dest_lat}?access_token=${config.MAPBOX_API_KEY}&overview=false`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Mapbox Directions failed with status code ${response.status}`);
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
  if (!verifyMapboxKey(res)) return;

  try {
    const url = `${MAPBOX_GEOCODING_BASE}/${encodeURIComponent(address)}.json?access_token=${config.MAPBOX_API_KEY}&autocomplete=true&limit=10&bbox=${KARACHI_BBOX}&country=pk&proximity=${KARACHI_CENTER.lng},${KARACHI_CENTER.lat}&types=poi,address,place,neighborhood,locality&language=en`;
    const apiResponse = await fetch(url);
    if (!apiResponse.ok) throw new Error("Failed");
    const body: any = await apiResponse.json();

    return sendSuccess(res, (body.features || []).map((f: any) => ({
      address: f.place_name,
      lat: f.center[1],
      lng: f.center[0]
    })));
  } catch (err: any) {
    return sendError(res, "AUTOCOMPLETE_ERROR", err.message, 500);
  }
});

/**
 * GET /api/maps/nearby-riders?lat=&lng=&radius_km=
 * Not a Mapbox call — a plain proximity query over our own rider location
 * data (rider_profiles.current_lat/current_lng), used by the admin
 * live-dispatch view. Exposes rider phone/location, so this is admin-only,
 * unlike the rest of this router's customer-facing routes.
 */
router.get("/nearby-riders", requireAuth, requireOperationsManager, async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return sendError(res, "VALIDATION_FAILED", "Please supply lat and lng query parameters.");
  }
  const radiusKm = Number(req.query.radius_km) || 10;

  try {
    // Field names (id/name/lat/lng/service) match what the admin dashboard's
    // LiveDispatch map/assignment UI expects. `id` is deliberately users.id,
    // not rider_profiles.id — that's the value ride_bookings.rider_id actually
    // stores, and what POST /api/dispatch/assign needs to receive as riderId.
    const rows = await db.query(
      `SELECT * FROM (
         SELECT
           u.id AS id,
           u.full_name AS name,
           u.phone AS phone,
           rp.current_lat AS lat,
           rp.current_lng AS lng,
           rp.vehicle_type AS service,
           COALESCE(rp.rating, 5.0) AS rating,
           (6371 * acos(LEAST(1, GREATEST(-1,
             cos(radians($1)) * cos(radians(rp.current_lat)) * cos(radians(rp.current_lng) - radians($2))
             + sin(radians($1)) * sin(radians(rp.current_lat))
           )))) AS distance_km
         FROM rider_profiles rp
         JOIN users u ON u.id = rp.user_id
         WHERE rp.is_online = true AND rp.current_lat IS NOT NULL AND rp.current_lng IS NOT NULL
       ) nearby
       WHERE distance_km <= $3
       ORDER BY distance_km ASC
       LIMIT 50`,
      [lat, lng, radiusKm]
    );
    // Wrapped as {items, total} so the admin API client's global list-unwrap
    // convention picks it up automatically, same as every other admin list endpoint.
    return sendSuccess(res, { items: rows, total: rows.length });
  } catch (err: any) {
    return sendError(res, "NEARBY_RIDERS_ERROR", err.message, 500);
  }
});

export default router;
