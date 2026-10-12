import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EARTH_RADIUS_M = 6_371_008.8;
const ROUTE_LENGTH_M = 180_000;
const SAMPLE_INTERVAL_M = 1_000;
const SEGMENT_INTERVAL_M = 30_000;
const FACILITY_CHAINAGES_M = [45_000, 90_000, 135_000];
const DEFAULT_OUTPUT_DIR = new URL(".", import.meta.url);

// These synthetic control points place the alignment near Lampang, Phayao and
// Chiang Rai without copying a road, customer pipeline or other route geometry.
const CONTROL_COORDINATES = [
  [99.2, 18.1],
  [99.38, 18.35],
  [99.55, 18.6],
  [99.72, 18.86],
  [99.88, 19.08],
  [99.76, 19.25],
  [99.77, 19.45],
];

function distanceMeters(start, end) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const [startLongitude, startLatitude] = start;
  const [endLongitude, endLatitude] = end;
  const latitudeDelta = radians(endLatitude - startLatitude);
  const longitudeDelta = radians(endLongitude - startLongitude);
  const startLatitudeRadians = radians(startLatitude);
  const endLatitudeRadians = radians(endLatitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitudeRadians) *
      Math.cos(endLatitudeRadians) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine));
}

function scaledControlCoordinates(scale) {
  const [originLongitude, originLatitude] = CONTROL_COORDINATES[0];
  return CONTROL_COORDINATES.map(([longitude, latitude]) => [
    originLongitude + (longitude - originLongitude) * scale,
    originLatitude + (latitude - originLatitude) * scale,
  ]);
}

function polylineLength(coordinates) {
  return coordinates.slice(1).reduce(
    (length, coordinate, index) =>
      length + distanceMeters(coordinates[index], coordinate),
    0,
  );
}

function controlCoordinatesForLength() {
  let lowerScale = 0;
  let upperScale = 2;

  for (let iteration = 0; iteration < 64; iteration += 1) {
    const scale = (lowerScale + upperScale) / 2;
    if (polylineLength(scaledControlCoordinates(scale)) < ROUTE_LENGTH_M) {
      lowerScale = scale;
    } else {
      upperScale = scale;
    }
  }

  return scaledControlCoordinates((lowerScale + upperScale) / 2);
}

function cumulativeDistances(coordinates) {
  return coordinates.reduce(
    (distances, coordinate, index) => {
      if (index === 0) {
        return [0];
      }
      return [
        ...distances,
        distances[index - 1] +
          distanceMeters(coordinates[index - 1], coordinate),
      ];
    },
    [],
  );
}

function coordinateAtDistance(coordinates, distances, chainage) {
  if (chainage <= 0) {
    return coordinates[0];
  }
  if (chainage >= distances[distances.length - 1]) {
    return coordinates[coordinates.length - 1];
  }

  const endIndex = distances.findIndex((distance) => distance >= chainage);
  const startIndex = endIndex - 1;
  const legLength = distances[endIndex] - distances[startIndex];
  const fraction = (chainage - distances[startIndex]) / legLength;
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const degrees = (value) => (value * 180) / Math.PI;
  const vectorFor = ([longitude, latitude]) => {
    const longitudeRadians = radians(longitude);
    const latitudeRadians = radians(latitude);
    return [
      Math.cos(latitudeRadians) * Math.cos(longitudeRadians),
      Math.cos(latitudeRadians) * Math.sin(longitudeRadians),
      Math.sin(latitudeRadians),
    ];
  };
  const startVector = vectorFor(coordinates[startIndex]);
  const endVector = vectorFor(coordinates[endIndex]);
  const dotProduct = Math.max(
    -1,
    Math.min(
      1,
      startVector.reduce(
        (sum, value, index) => sum + value * endVector[index],
        0,
      ),
    ),
  );
  const angle = Math.acos(dotProduct);
  const sine = Math.sin(angle);
  if (Math.abs(sine) < Number.EPSILON) {
    return coordinates[startIndex];
  }

  const startWeight = Math.sin((1 - fraction) * angle) / sine;
  const endWeight = Math.sin(fraction * angle) / sine;
  const vector = startVector.map(
    (value, index) => value * startWeight + endVector[index] * endWeight,
  );
  return [
    degrees(Math.atan2(vector[1], vector[0])),
    degrees(Math.atan2(vector[2], Math.hypot(vector[0], vector[1]))),
  ];
}

function roundedCoordinate(coordinate) {
  return coordinate.map((value) => Number(value.toFixed(7)));
}

function feature(id, geometry, properties) {
  return { type: "Feature", id, geometry, properties };
}

function collection(features) {
  return { type: "FeatureCollection", features };
}

export function buildDataset() {
  const controls = controlCoordinatesForLength();
  const controlsDistances = cumulativeDistances(controls);
  const sampleChainages = new Set();
  for (
    let chainage = 0;
    chainage <= ROUTE_LENGTH_M;
    chainage += SAMPLE_INTERVAL_M
  ) {
    sampleChainages.add(chainage);
  }
  for (const chainage of controlsDistances) {
    sampleChainages.add(chainage);
  }
  const routePoints = [];

  for (const chainage of [...sampleChainages].sort((a, b) => a - b)) {
    routePoints.push({
      chainage,
      coordinate: roundedCoordinate(
        coordinateAtDistance(controls, controlsDistances, chainage),
      ),
    });
  }

  const routeProperties = {
    asset_code: "DL-01",
    name: "DL-01",
    label: "SYNTHETIC",
    type: "linear",
    domain_pack: "pipeline-integrity",
    nominal_diameter_in: 30,
    length_m: ROUTE_LENGTH_M,
    start_region: "Lampang",
    via_regions: ["Phayao"],
    end_region: "Chiang Rai",
    simulated: true,
    classification: "HIGHLY_RESTRICTED",
  };
  const route = feature(
    "dl-01-route",
    {
      type: "LineString",
      coordinates: routePoints.map(({ coordinate }) => coordinate),
    },
    routeProperties,
  );

  const segments = [];
  for (
    let chainageFrom = 0, number = 1;
    chainageFrom < ROUTE_LENGTH_M;
    chainageFrom += SEGMENT_INTERVAL_M, number += 1
  ) {
    const chainageTo = Math.min(
      chainageFrom + SEGMENT_INTERVAL_M,
      ROUTE_LENGTH_M,
    );
    const coordinates = routePoints
      .filter(
        ({ chainage }) => chainage >= chainageFrom && chainage <= chainageTo,
      )
      .map(({ coordinate }) => coordinate);
    const paddedNumber = String(number).padStart(3, "0");
    segments.push(
      feature(
        "dl-01-segment-" + paddedNumber,
        { type: "LineString", coordinates },
        {
          name: "DL-01 Segment " + paddedNumber,
          segment_number: number,
          chainage_from_m: chainageFrom,
          chainage_to_m: chainageTo,
          label: "SYNTHETIC",
          simulated: true,
          classification: "HIGHLY_RESTRICTED",
        },
      ),
    );
  }

  const facilities = FACILITY_CHAINAGES_M.map((chainage, index) => {
    const number = index + 1;
    const paddedNumber = String(number).padStart(3, "0");
    const routePoint = routePoints.find(
      (point) => point.chainage === chainage,
    );
    if (!routePoint) {
      throw new Error("Facility Chainage is missing from the generated route.");
    }
    return feature(
      "dl-01-bvs-" + paddedNumber,
      { type: "Point", coordinates: routePoint.coordinate },
      {
        name: "DL-01 Block Valve Station " + paddedNumber,
        facility_type: "block_valve_station",
        chainage_m: chainage,
        label: "SYNTHETIC",
        simulated: true,
        classification: "HIGHLY_RESTRICTED",
      },
    );
  });

  return {
    route: collection([route]),
    segments: collection(segments),
    facilities: collection(facilities),
  };
}

export async function writeDataset(outputDir = DEFAULT_OUTPUT_DIR) {
  const directory = resolve(outputDir instanceof URL ? outputDir.pathname : outputDir);
  const dataset = buildDataset();
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(directory, "route.geojson"),
      JSON.stringify(dataset.route, null, 2) + "\n",
      "utf8",
    ),
    writeFile(
      resolve(directory, "segments.geojson"),
      JSON.stringify(dataset.segments, null, 2) + "\n",
      "utf8",
    ),
    writeFile(
      resolve(directory, "facilities.geojson"),
      JSON.stringify(dataset.facilities, null, 2) + "\n",
      "utf8",
    ),
  ]);
  return dataset;
}

function outputDirectoryFromArguments(argumentsList) {
  const outputIndex = argumentsList.indexOf("--output-dir");
  if (outputIndex === -1) {
    return DEFAULT_OUTPUT_DIR;
  }
  const outputDirectory = argumentsList[outputIndex + 1];
  if (!outputDirectory || outputDirectory.startsWith("--")) {
    throw new Error("--output-dir requires a directory path.");
  }
  return outputDirectory;
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  writeDataset(outputDirectoryFromArguments(process.argv.slice(2))).catch(
    (error) => {
      console.error(error instanceof Error ? error.message : "Generation failed.");
      process.exitCode = 1;
    },
  );
}
