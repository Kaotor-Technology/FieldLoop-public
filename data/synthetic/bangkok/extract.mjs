import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL(".", import.meta.url);
export const DISTRICT_IDS = [2938032, 2939952];
export const ATTRIBUTION = "© OpenStreetMap contributors";
export const LICENCE_URL = "https://www.openstreetmap.org/copyright";
const TAGS = ["name", "name:en", "name:th", "waterway", "boundary", "admin_level", "type"];
const CANAL_QUERY = '[out:json][timeout:40];(rel["boundary"="administrative"]["name:en"="Huai Khwang"](13.65,100.4,13.95,100.8);rel["boundary"="administrative"]["name:en"="Bang Kapi"](13.65,100.4,13.95,100.8);way["waterway"="canal"](13.74,100.56,13.81,100.65););out geom;';
export const SOURCES = [
  { file: "canals.json", url: "https://overpass.private.coffee/api/interpreter?" + new URLSearchParams({ data: CANAL_QUERY }), query: CANAL_QUERY },
  ...DISTRICT_IDS.map((id) => ({ file: `district-${id}.json`, url: `https://www.openstreetmap.org/api/0.6/relation/${id}/full.json` })),
];

// Keep geometry, version and source timestamps; omit user names and unrelated tags/statistics.
export function normalizeSource(source) {
  if (source.remark || !Array.isArray(source.elements) || source.elements.length === 0) {
    throw new Error("OSM source is empty or reports an error.");
  }
  return {
    osm3s: source.osm3s ?? null,
    elements: source.elements.map((element) => Object.fromEntries([
      ...["type", "id", "version", "timestamp", "lat", "lon", "nodes", "geometry", "members"]
        .filter((key) => element[key] !== undefined).map((key) => [key, element[key]]),
      ["tags", Object.fromEntries(TAGS.filter((key) => element.tags?.[key] !== undefined)
        .map((key) => [key, element.tags[key]]))],
    ])),
  };
}

function coordinate(node) {
  if (!node || !Number.isFinite(node.lon) || !Number.isFinite(node.lat)
      || node.lon < -180 || node.lon > 180 || node.lat < -90 || node.lat > 90) {
    throw new Error("OSM geometry has a missing or invalid coordinate.");
  }
  return [node.lon, node.lat];
}

// Join by OSM node identity, not rounded coordinates. Reject incomplete or branching boundaries.
export function boundaryGeometry(source, relationId) {
  const elements = new Map(source.elements.map((element) => [`${element.type}/${element.id}`, element]));
  const relation = elements.get(`relation/${relationId}`);
  if (!relation || relation.tags?.boundary !== "administrative") throw new Error("District relation is missing.");
  const rings = (role) => {
    const remaining = relation.members.filter((member) => member.role === role).map((member) => {
      const way = elements.get(`way/${member.ref}`);
      if (member.type !== "way" || !way?.nodes || way.nodes.length < 2) throw new Error("District way is missing.");
      return [...way.nodes];
    });
    const result = [];
    while (remaining.length) {
      const chain = remaining.shift();
      while (chain[0] !== chain.at(-1)) {
        const matches = remaining.flatMap((nodes, index) =>
          nodes[0] === chain.at(-1) || nodes.at(-1) === chain.at(-1) ? [index] : []);
        if (matches.length !== 1) throw new Error("District boundary is open or ambiguous.");
        const nodes = remaining.splice(matches[0], 1)[0];
        if (nodes[0] !== chain.at(-1)) nodes.reverse();
        chain.push(...nodes.slice(1));
      }
      if (new Set(chain).size < 3) throw new Error("District boundary ring is degenerate.");
      result.push(chain.map((id) => coordinate(elements.get(`node/${id}`))));
    }
    return result;
  };
  const outer = rings("outer");
  if (outer.length === 0) throw new Error("District has no outer ring.");
  const polygons = outer.map((ring) => [ring]);
  for (const hole of rings("inner")) {
    const containers = polygons.filter(([ring]) => pointInRing(hole[0], ring));
    if (containers.length !== 1) throw new Error("District hole has no unique outer ring.");
    containers[0].push(hole);
  }
  return { type: "MultiPolygon", coordinates: polygons };
}

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInArea(point, geometry) {
  return geometry.coordinates.some(([outer, ...holes]) =>
    pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole)));
}

function feature(element, geometry) {
  return {
    type: "Feature", id: `osm-${element.type}-${element.id}`, geometry,
    properties: {
      name: element.tags["name:en"] ?? element.tags.name ?? `OSM ${element.type} ${element.id}`,
      name_th: element.tags["name:th"] ?? element.tags.name ?? null,
      osm_type: element.type, osm_id: element.id,
      source: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      attribution: ATTRIBUTION, licence: "ODbL-1.0", licence_url: LICENCE_URL,
      label: "PUBLIC BASE MAP", simulated: false, classification: "PUBLIC",
    },
  };
}

export function buildExtract(sources) {
  const canals = sources[0].elements.filter((element) => element.type === "way" && element.tags?.waterway === "canal")
    .sort((a, b) => a.id - b.id).map((element) => {
      if (!Array.isArray(element.geometry) || element.geometry.length < 2) throw new Error("Canal geometry is missing.");
      return feature(element, { type: "LineString", coordinates: element.geometry.map(coordinate) });
    });
  if (canals.length === 0) throw new Error("No canals in the extract.");
  const districts = DISTRICT_IDS.map((id, index) => {
    const source = sources[index + 1];
    const relation = source.elements.find((element) => element.type === "relation" && element.id === id);
    return feature(relation, boundaryGeometry(source, id));
  });
  return Object.fromEntries([ ["canals", canals], ["districts", districts] ].map(([key, features]) =>
    [key, { type: "FeatureCollection", attribution: ATTRIBUTION, licence: "ODbL-1.0", features }]));
}

export function readSources() {
  const manifest = JSON.parse(readFileSync(new URL("sources/manifest.json", ROOT), "utf8"));
  return SOURCES.map(({ file }, index) => {
    const bytes = readFileSync(new URL(`sources/${file}`, ROOT));
    if (manifest.sources[index]?.file !== file || createHash("sha256").update(bytes).digest("hex") !== manifest.sources[index].sha256) {
      throw new Error(`Source hash mismatch: ${file}`);
    }
    return normalizeSource(JSON.parse(bytes));
  });
}

export function writeExtract(outputDir = ROOT) {
  const dataset = buildExtract(readSources());
  mkdirSync(outputDir, { recursive: true });
  for (const [key, collection] of Object.entries(dataset)) {
    const target = outputDir instanceof URL ? new URL(`${key}.geojson`, outputDir) : resolve(outputDir, `${key}.geojson`);
    writeFileSync(target, JSON.stringify(collection, null, 2) + "\n");
  }
  return dataset;
}

async function refreshSources() {
  const snapshots = [];
  for (const spec of SOURCES) {
    const response = await fetch(spec.url, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "FieldLoop-demo-extract/1.0" } });
    if (!response.ok) throw new Error(`OSM download failed: HTTP ${response.status}`);
    snapshots.push(normalizeSource(await response.json()));
  }
  buildExtract(snapshots); // Validate every download before replacing any saved source.
  const manifest = { retrievedAt: new Date().toISOString(), attribution: ATTRIBUTION, licence: "ODbL-1.0", sources: [] };
  for (const [index, snapshot] of snapshots.entries()) {
    const bytes = JSON.stringify(snapshot) + "\n";
    writeFileSync(new URL(`sources/${SOURCES[index].file}`, ROOT), bytes);
    manifest.sources.push({ ...SOURCES[index], sha256: createHash("sha256").update(bytes).digest("hex"), osmBaseTimestamp: snapshot.osm3s?.timestamp_osm_base ?? null });
  }
  writeFileSync(new URL("sources/manifest.json", ROOT), JSON.stringify(manifest, null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--refresh") await refreshSources();
    else if (args.length && !(args.length === 2 && args[0] === "--output-dir")) throw new Error("Usage: extract.mjs [--refresh | --output-dir PATH]");
    const dataset = writeExtract(args[0] === "--output-dir" ? args[1] : ROOT);
    console.log(`Extracted ${dataset.canals.features.length} canal ways and ${dataset.districts.features.length} districts (OSM / ODbL-1.0).`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
