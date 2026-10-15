import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EARTH_RADIUS_M = 6_371_008.8;
const DEFAULT_OUTPUT_DIR = new URL(".", import.meta.url);
const ROUTE_URL = new URL("route.geojson", import.meta.url);
const KML_NAMESPACE = "http://www.opengis.net/kml/2.2";

// Ten SYNTHETIC findings beside the SYNTHETIC DL-01 route. Chainages and signed
// offsets (positive is left of travel) are authored here; every offset is well
// inside the 50 m snap tolerance. Nothing traces a real pipeline or site.
const FINDINGS = [
  { chainage: 4_500, offset: 8, category: "vehicle track" },
  { chainage: 18_250, offset: -15, category: "excavation" },
  { chainage: 31_000, offset: 22, category: "structure" },
  { chainage: 47_500, offset: -12, category: "excavation" },
  { chainage: 62_250, offset: 30, category: "tree planting" },
  { chainage: 79_000, offset: -18, category: "vehicle track" },
  { chainage: 95_500, offset: 25, category: "structure" },
  { chainage: 112_750, offset: -10, category: "excavation" },
  { chainage: 131_500, offset: 35, category: "fence line" },
  { chainage: 160_250, offset: -20, category: "tree planting" },
];
// One finding authored beyond the 50 m snap tolerance (Edge case in FL-48).
const OUTSIDE_TOLERANCE_FINDING = { chainage: 70_000, offset: 80, category: "excavation" };

function radians(degrees) {
  return (degrees * Math.PI) / 180;
}

function distanceMeters([startLongitude, startLatitude], [endLongitude, endLatitude]) {
  const latitudeDelta = radians(endLatitude - startLatitude);
  const longitudeDelta = radians(endLongitude - startLongitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(startLatitude)) * Math.cos(radians(endLatitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine));
}

// Route legs are about 1 km, so linear interpolation inside a leg is within centimetres.
function pointBesideRoute(route, { chainage, offset }) {
  let travelled = 0;
  for (let index = 1; index < route.length; index += 1) {
    const [start, end] = [route[index - 1], route[index]];
    const leg = distanceMeters(start, end);
    if (leg > 0 && travelled + leg >= chainage) {
      const fraction = (chainage - travelled) / leg;
      const longitude = start[0] + (end[0] - start[0]) * fraction;
      const latitude = start[1] + (end[1] - start[1]) * fraction;
      const metresPerLongitude = (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(radians(latitude));
      const metresPerLatitude = (Math.PI / 180) * EARTH_RADIUS_M;
      const east = (end[0] - start[0]) * metresPerLongitude;
      const north = (end[1] - start[1]) * metresPerLatitude;
      const length = Math.hypot(east, north);
      return [
        Number((longitude + ((-north / length) * offset) / metresPerLongitude).toFixed(7)),
        Number((latitude + ((east / length) * offset) / metresPerLatitude).toFixed(7)),
      ];
    }
    travelled += leg;
  }
  throw new Error(`Chainage ${chainage} is beyond the synthetic route.`);
}

function placemark(route, finding, name, index) {
  const [longitude, latitude] = pointBesideRoute(route, finding);
  return [
    "    <Placemark>",
    `      <name>${name} ${String(index + 1).padStart(2, "0")}</name>`,
    "      <description>SYNTHETIC finding. Not a real encroachment.</description>",
    "      <ExtendedData>",
    `        <Data name="category"><value>${finding.category}</value></Data>`,
    "      </ExtendedData>",
    `      <Point><coordinates>${longitude},${latitude},0</coordinates></Point>`,
    "    </Placemark>",
  ].join("\n");
}

function document(title, placemarks) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<kml xmlns="${KML_NAMESPACE}">`,
    "  <Document>",
    `    <name>${title}</name>`,
    "    <Folder>",
    "      <name>Right-of-Way patrol (SYNTHETIC)</name>",
    placemarks.join("\n"),
    "    </Folder>",
    "  </Document>",
    "</kml>",
    "",
  ].join("\n");
}

export async function buildEncroachmentFixtures() {
  const geojson = JSON.parse(await readFile(ROUTE_URL, "utf8"));
  const route = geojson.features[0].geometry.coordinates;
  return {
    "encroachment-points.kml": document(
      "DL-01 encroachment findings (SYNTHETIC)",
      FINDINGS.map((finding, index) => placemark(route, finding, "Synthetic encroachment", index)),
    ),
    "encroachment-outside-tolerance.kml": document(
      "DL-01 finding outside snap tolerance (SYNTHETIC)",
      [placemark(route, OUTSIDE_TOLERANCE_FINDING, "Synthetic finding outside tolerance", 0)],
    ),
  };
}

export async function writeEncroachmentFixtures(outputDir = DEFAULT_OUTPUT_DIR) {
  const directory = outputDir instanceof URL ? outputDir : pathToFileURL(`${resolve(outputDir)}/`);
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(await buildEncroachmentFixtures())) {
    await writeFile(new URL(name, directory), content);
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const flag = process.argv.indexOf("--output-dir");
  await writeEncroachmentFixtures(flag === -1 ? DEFAULT_OUTPUT_DIR : process.argv[flag + 1]);
}
