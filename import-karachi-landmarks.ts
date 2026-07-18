/**
 * Seeds/updates the `landmarks` table used to supplement Mapbox's geocoding
 * for Karachi (Mapbox's own POI index was verified to have almost no
 * coverage here — see PRODUCT.md).
 *
 * Three modes:
 *   node import-karachi-landmarks.ts                -> pulls curated
 *                                                       categories from
 *                                                       OpenStreetMap via the
 *                                                       public Overpass API
 *   node import-karachi-landmarks.ts --geojson FILE -> imports a GeoJSON
 *                                                       FeatureCollection —
 *                                                       the standard `osmium
 *                                                       export` output, e.g.
 *                                                       from filtering/
 *                                                       clipping
 *                                                       pakistan-latest.osm.pbf
 *                                                       to Karachi. Handles
 *                                                       Point, LineString, and
 *                                                       Polygon geometries
 *                                                       (streets/areas use
 *                                                       their first
 *                                                       coordinate as a
 *                                                       representative point).
 *   node import-karachi-landmarks.ts --csv FILE     -> imports a hand-
 *                                                       maintained CSV
 *                                                       instead (columns:
 *                                                       name,category,
 *                                                       address,lat,lng)
 *   node import-karachi-landmarks.ts --extract FILE -> imports the specific
 *                                                       {category: [{id,
 *                                                       type,name,lat,lon,
 *                                                       tags}]} shape produced
 *                                                       by karachi_map_data/
 *                                                       parse_pbf.js (a
 *                                                       custom local PBF
 *                                                       parser, not osmium).
 *                                                       Category comes from
 *                                                       the object key;
 *                                                       unnamed address nodes
 *                                                       get a synthesized
 *                                                       name from their
 *                                                       housenumber/street.
 *
 * All four modes upsert by id, so re-running any of them is safe.
 */
import fs from "fs";
import { db } from "./src/db/index";

// south,west,north,east — matches KARACHI_BBOX in src/modules/maps/maps.routes.ts
const KARACHI_BOUNDS = "24.73,66.82,25.18,67.42";

// Curated, landmark-tier OSM tags only (not "every shop/mosque in the city")
// — this keeps the dataset relevant to what someone would actually type as a
// ride/ambulance pickup or dropoff, rather than flooding search results.
const OSM_QUERIES = [
  { tag: `["amenity"="hospital"]`, category: "hospital" },
  { tag: `["amenity"="clinic"]["name"]`, category: "clinic" },
  { tag: `["shop"="mall"]`, category: "mall" },
  { tag: `["amenity"="university"]`, category: "university" },
  { tag: `["amenity"="college"]`, category: "college" },
  { tag: `["aeroway"="aerodrome"]`, category: "airport" },
  { tag: `["railway"="station"]`, category: "railway_station" },
  { tag: `["amenity"="bus_station"]`, category: "bus_station" },
  { tag: `["amenity"="marketplace"]`, category: "market" },
  { tag: `["leisure"="park"]["name"]`, category: "park" },
  { tag: `["leisure"="stadium"]`, category: "stadium" },
  { tag: `["tourism"="attraction"]`, category: "attraction" },
  { tag: `["tourism"="museum"]`, category: "museum" },
  { tag: `["amenity"="townhall"]`, category: "government" },
];

interface LandmarkRow {
  id: string;
  name: string;
  category: string;
  address: string | null;
  lat: number;
  lng: number;
  source: string;
  external_id: string | null;
}

function buildAddress(tags: Record<string, string>): string | null {
  const parts = [
    tags["addr:housenumber"],
    tags["addr:street"] || tags["addr:place"],
    tags["addr:suburb"],
    tags["addr:city"] || "Karachi",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

async function fetchFromOverpass(): Promise<LandmarkRow[]> {
  const rows: LandmarkRow[] = [];

  for (const { tag, category } of OSM_QUERIES) {
    const query = `[out:json][timeout:60];(node${tag}(${KARACHI_BOUNDS});way${tag}(${KARACHI_BOUNDS}););out center;`;
    console.log(`Fetching category "${category}"...`);

    try {
      // Overpass's public instance rejects requests with no User-Agent (406)
      // and rate-limits bursts (504) — one retry after a cooldown covers both.
      let res = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "ShazoRideLandmarkImporter/1.0 (contact: admin@shazoride.com)",
        },
      });
      if (!res.ok) {
        console.warn(`  HTTP ${res.status}, retrying once after cooldown...`);
        await new Promise((r) => setTimeout(r, 8000));
        res = await fetch("https://overpass-api.de/api/interpreter", {
          method: "POST",
          body: "data=" + encodeURIComponent(query),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "ShazoRideLandmarkImporter/1.0 (contact: admin@shazoride.com)",
          },
        });
      }
      if (!res.ok) {
        console.warn(`  skipped (HTTP ${res.status})`);
        continue;
      }
      const body: any = await res.json();
      const elements = body.elements || [];

      for (const el of elements) {
        const tags = el.tags || {};
        const name = tags.name;
        if (!name) continue; // unnamed elements aren't useful for search

        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (lat === undefined || lng === undefined) continue;

        rows.push({
          id: `osm_${el.type}_${el.id}`,
          name,
          category,
          address: buildAddress(tags),
          lat,
          lng,
          source: "osm",
          external_id: `${el.type}/${el.id}`,
        });
      }
      console.log(`  -> ${elements.length} raw element(s), ${elements.filter((e: any) => e.tags?.name).length} named`);
    } catch (err: any) {
      console.warn(`  failed: ${err.message}`);
    }

    // Be polite to the free public Overpass instance.
    await new Promise((r) => setTimeout(r, 4000));
  }

  return rows;
}

// A GeoJSON FeatureCollection is the standard export format from `osmium
// export` — the expected shape for the user's own pakistan-latest.osm.pbf
// extract (districts/towns/zones/colonies/landmarks/hospitals/streets/
// addresses). Point geometries use their coordinate directly; Line/Polygon
// geometries (streets, area boundaries) use their first coordinate as a
// representative point, since this table only stores a single lat/lng.
function categoryFromTags(props: Record<string, any>): string {
  const tagKeys = ["amenity", "shop", "tourism", "leisure", "aeroway", "railway", "highway", "place", "boundary", "landuse", "office", "building"];
  for (const key of tagKeys) {
    if (props[key]) return `${key}:${props[key]}`;
  }
  return "other";
}

function firstCoordinate(geometry: any): [number, number] | null {
  if (!geometry) return null;
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "LineString" || geometry.type === "MultiPoint") return geometry.coordinates[0];
  if (geometry.type === "Polygon") return geometry.coordinates[0]?.[0];
  if (geometry.type === "MultiLineString" || geometry.type === "MultiPolygon") return geometry.coordinates[0]?.[0]?.[0] ?? geometry.coordinates[0]?.[0];
  return null;
}

function parseGeoJson(path: string): LandmarkRow[] {
  const stats = fs.statSync(path);
  if (stats.size > 150 * 1024 * 1024) {
    console.warn(`Warning: ${path} is ${(stats.size / 1024 / 1024).toFixed(0)}MB — consider pre-filtering with ` +
      `"osmium tags-filter" and clipping to a Karachi bbox before exporting, rather than importing a whole-country dump.`);
  }

  const geojson = JSON.parse(fs.readFileSync(path, "utf-8"));
  const features = geojson.features || geojson.elements || [];
  const rows: LandmarkRow[] = [];

  for (const feature of features) {
    const props = feature.properties || feature.tags || {};
    const name = props.name;
    if (!name) continue; // unnamed features aren't useful for search

    const coord = firstCoordinate(feature.geometry);
    if (!coord) continue;
    const [lng, lat] = coord;

    const address = [props["addr:housenumber"], props["addr:street"], props["addr:suburb"], props["addr:city"] || "Karachi"]
      .filter(Boolean).join(", ") || null;

    const externalId = feature.id ?? props["@id"] ?? null;
    rows.push({
      id: `osm_geojson_${Buffer.from(String(externalId ?? name + lat + lng)).toString("base64url").slice(0, 32)}`,
      name,
      category: categoryFromTags(props),
      address,
      lat,
      lng,
      source: "osm_extract",
      external_id: externalId ? String(externalId) : null,
    });
  }
  return rows;
}

// Shape produced by the user's own custom PBF parser (karachi_map_data/
// parse_pbf.js, using the `osm-read` package): a plain object keyed by
// category, each value an array of {id, type, name, lat, lon, tags}. Unlike
// the GeoJSON path, the category is already known from the key — no need to
// re-derive it from tags. Many raw address nodes have no `tags.name` at all
// (that's normal for OSM — they're just a housenumber+street), so a name is
// synthesized from address components instead of skipping them.
function parseCustomExtract(path: string): LandmarkRow[] {
  const stats = fs.statSync(path);
  console.log(`Reading ${(stats.size / 1024 / 1024).toFixed(0)}MB extract file...`);
  const data = JSON.parse(fs.readFileSync(path, "utf-8"));
  const rows: LandmarkRow[] = [];

  for (const category of Object.keys(data)) {
    const items = data[category];
    if (!Array.isArray(items)) continue;

    for (const el of items) {
      const tags = el.tags || {};
      let name = el.name || tags.name || tags["name:en"];

      if (!name) {
        // No POI name — synthesize one from address components so it's
        // still searchable by street/area (e.g. "12-A, PECHS Block 2").
        const parts = [tags["addr:housenumber"], tags["addr:street"] || tags["addr:place"]].filter(Boolean);
        if (parts.length === 0) continue; // nothing usable to search by
        name = parts.join(", ");
      }

      if (el.lat === undefined || el.lon === undefined) continue;

      const address = [tags["addr:housenumber"], tags["addr:street"] || tags["addr:place"], tags["addr:suburb"], tags["addr:city"] || "Karachi"]
        .filter(Boolean).join(", ") || null;

      rows.push({
        id: `osm_${el.type || "n"}_${el.id}`,
        name,
        category,
        address,
        lat: el.lat,
        lng: el.lon,
        source: "osm_extract",
        external_id: String(el.id),
      });
    }
  }
  return rows;
}

function parseCsv(path: string): LandmarkRow[] {
  const text = fs.readFileSync(path, "utf-8");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const rows: LandmarkRow[] = [];

  for (const line of lines.slice(1)) {
    // Simple CSV split — fine for this controlled, hand-maintained input.
    const cols = line.split(",").map((c) => c.trim());
    const record: Record<string, string> = {};
    header.forEach((h, i) => (record[h] = cols[i] ?? ""));

    if (!record.name || !record.lat || !record.lng) continue;

    rows.push({
      id: `manual_${Buffer.from(record.name + record.lat + record.lng).toString("base64url").slice(0, 24)}`,
      name: record.name,
      category: record.category || "manual",
      address: record.address || null,
      lat: Number(record.lat),
      lng: Number(record.lng),
      source: "manual",
      external_id: null,
    });
  }
  return rows;
}

async function upsert(rows: LandmarkRow[]) {
  // One row per round-trip is fine for a few thousand rows (the OSM/CSV/
  // GeoJSON paths), but a 100k+-row custom extract would take a very long
  // time serially against a remote pooler. Batch into multi-row VALUES
  // statements instead.
  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values: any[] = [];
    const placeholders = batch.map((row, idx) => {
      const base = idx * 8;
      values.push(row.id, row.name, row.category, row.address, row.lat, row.lng, row.source, row.external_id);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},NOW())`;
    });

    await db.query(
      `INSERT INTO landmarks (id, name, category, address, lat, lng, source, external_id, updated_at)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         category = EXCLUDED.category,
         address = EXCLUDED.address,
         lat = EXCLUDED.lat,
         lng = EXCLUDED.lng,
         updated_at = NOW()`,
      values
    );
    inserted += batch.length;
    if (inserted % 5000 < BATCH_SIZE) console.log(`  ...${inserted}/${rows.length}`);
  }
  return inserted;
}

async function main() {
  const csvArgIndex = process.argv.indexOf("--csv");
  const geojsonArgIndex = process.argv.indexOf("--geojson");
  const extractArgIndex = process.argv.indexOf("--extract");

  let rows: LandmarkRow[];
  if (csvArgIndex !== -1) {
    rows = parseCsv(process.argv[csvArgIndex + 1]);
  } else if (geojsonArgIndex !== -1) {
    rows = parseGeoJson(process.argv[geojsonArgIndex + 1]);
  } else if (extractArgIndex !== -1) {
    rows = parseCustomExtract(process.argv[extractArgIndex + 1]);
  } else {
    rows = await fetchFromOverpass();
  }

  console.log(`\nUpserting ${rows.length} landmark(s)...`);
  const count = await upsert(rows);
  console.log(`Done. ${count} row(s) upserted into landmarks.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
