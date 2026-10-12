import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildExtract, readSources, pointInArea } from "./extract.mjs";

const ROOT = new URL(".", import.meta.url);
// Authored illustrative coordinates. No real pump, gate or sensor location is used.
const FACILITIES = [
  ["P-1", "pump", "Z3", [100.575, 13.776]],
  ["P-3", "pump", "Z3", [100.58, 13.775]],
  ["P-2", "pump", "Z4", [100.635, 13.765]],
  ["G-1", "gate", "Z3", [100.582, 13.777]],
  ["G-2", "gate", "Z4", [100.64, 13.775]],
  ["S-R1", "rain_sensor", "Z3", [100.578, 13.778]],
  ["S-L1", "level_sensor", "Z3", [100.583, 13.776]],
  ["S-T1", "tide_sensor", "Z4", [100.63, 13.79]],
];

export function buildDataset() {
  const { canals, districts } = buildExtract(readSources());
  const zones = {
    type: "FeatureCollection",
    features: districts.features.map((district, index) => ({
      type: "Feature", id: `Z${index + 3}`, geometry: district.geometry,
      properties: {
        asset_code: `Z${index + 3}`, name: `Demo drainage zone Z${index + 3} (SIMULATION)`,
        name_th: `พื้นที่ระบายน้ำจำลอง Z${index + 3}`,
        label: "SIMULATION", simulated: true, classification: "HIGHLY_RESTRICTED",
        geometry_source: district.properties.source, attribution: district.properties.attribution,
        licence: district.properties.licence, licence_url: district.properties.licence_url,
        geometry_basis: "OSM district footprint used as an illustrative drainage zone; not a verified catchment.",
      },
    })),
  };
  const facilities = {
    type: "FeatureCollection",
    features: FACILITIES.map(([code, facilityType, zoneCode, coordinates]) => {
      const zone = zones.features.find(({ id }) => id === zoneCode);
      if (!zone || !pointInArea(coordinates, zone.geometry)) throw new Error(`Facility ${code} is outside its demo zone.`);
      return {
        type: "Feature", id: code, geometry: { type: "Point", coordinates },
        properties: {
          asset_code: code, facility_type: facilityType, zone_code: zoneCode,
          name: `Demo ${facilityType.replaceAll("_", " ")} ${code} (SYNTHETIC)`,
          label: "SYNTHETIC", simulated: true, classification: "HIGHLY_RESTRICTED",
          location_basis: "Authored synthetic coordinates; not a real Facility location.",
        },
      };
    }),
  };
  return { canals, districts, zones, facilities };
}

export function writeDataset(outputDir = ROOT) {
  const dataset = buildDataset();
  mkdirSync(outputDir, { recursive: true });
  for (const [name, collection] of Object.entries(dataset)) {
    const target = outputDir instanceof URL ? new URL(`${name}.geojson`, outputDir) : resolve(outputDir, `${name}.geojson`);
    writeFileSync(target, JSON.stringify(collection, null, 2) + "\n");
  }
  return dataset;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === "--output-dir")) throw new Error("Usage: generate.mjs [--output-dir PATH]");
    const dataset = writeDataset(args[1] ?? ROOT);
    console.log(`Generated ${dataset.zones.features.length} demo zones and ${dataset.facilities.features.length} synthetic Facilities.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
