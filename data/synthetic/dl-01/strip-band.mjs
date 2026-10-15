import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function buildStripBand({ route, segments, facilities, bowtie }) {
  const classificationOrder = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"];
  const requiredText = (value) => typeof value === "string" && value.trim().length > 0;
  if (!requiredText(route.features[0]?.properties.asset_code) ||
      [...segments.features, ...facilities.features, ...bowtie.barriers].some(({ id }) => !requiredText(id))) {
    throw new Error("Invalid strip identifier.");
  }
  if ([...segments.features, ...facilities.features].some(({ properties }) => !requiredText(properties.name)) ||
      bowtie.barriers.some(({ name }) => !requiredText(name))) {
    throw new Error("Invalid strip name.");
  }
  const classifications = new Set(classificationOrder);
  const features = [...route.features, ...segments.features, ...facilities.features];
  if (route.features.length !== 1 || bowtie.assetCode !== route.features[0].properties.asset_code ||
      bowtie.metadata.label !== "SYNTHETIC" || bowtie.metadata.simulated !== true ||
      !classifications.has(bowtie.metadata.classification) ||
      features.some(({ properties }) => properties.label !== "SYNTHETIC" ||
        properties.simulated !== true || !classifications.has(properties.classification))) {
    throw new Error("Strip source must be classified synthetic data for the same Asset.");
  }
  const lengthM = route.features[0].properties.length_m;
  if (!Number.isFinite(lengthM) || lengthM <= 0) throw new Error("Invalid Asset length.");
  const ordered = [...segments.features].sort((a, b) => a.properties.chainage_from_m - b.properties.chainage_from_m);
  let end = 0;
  for (const { properties } of ordered) {
    if (properties.chainage_from_m !== end || !Number.isFinite(properties.chainage_to_m) ||
        properties.chainage_to_m <= end || properties.chainage_to_m > lengthM) {
      throw new Error("Segments must cover the Asset continuously without gaps or overlaps.");
    }
    end = properties.chainage_to_m;
  }
  if (end !== lengthM) throw new Error("Segments must cover the complete Asset.");
  for (const { properties } of facilities.features) {
    if (!Number.isFinite(properties.chainage_m) || properties.chainage_m < 0 || properties.chainage_m > lengthM) {
      throw new Error("Facility Chainage must lie within its Asset.");
    }
  }
  const healthStates = new Set(["healthy", "degraded", "failed", "unverified"]);
  if (bowtie.barriers.some(({ health }) => !healthStates.has(health))) {
    throw new Error("Invalid Barrier Health.");
  }
  const asset = route.features[0].properties;
  return {
    schemaVersion: 1,
    assetCode: asset.asset_code,
    lengthM: asset.length_m,
    classification: classificationOrder[Math.max(...features.map(({ properties }) =>
      classificationOrder.indexOf(properties.classification)), classificationOrder.indexOf(bowtie.metadata.classification))],
    simulated: asset.simulated,
    label: asset.label,
    // Bowtie A scopes to the whole Asset. No confirmed GeoReference in this seed
    // locates its Barriers. Facility Chainage must never be used as Barrier Chainage.
    barriers: bowtie.barriers.map(({ id, name, health }) => ({ id, name, health, chainageM: null })),
    facilities: facilities.features.map(({ id, properties }) => ({
      id, name: properties.name, chainageM: properties.chainage_m,
    })).sort((a, b) => a.chainageM - b.chainageM),
    // Evidence dates are not inspection geometry, and Threats are not pack Categories.
    inspections: [],
    threatCategories: [],
    segments: segments.features.map(({ id, properties }) => ({
      id, name: properties.name,
      chainageFromM: properties.chainage_from_m,
      chainageToM: properties.chainage_to_m,
    })).sort((a, b) => a.chainageFromM - b.chainageFromM),
  };
}

export function serializeStripBand(band) {
  return JSON.stringify(band, null, 2) + "\n";
}

export function checkStripBand(file, source) {
  if (readFileSync(file, "utf8") !== serializeStripBand(buildStripBand(source))) {
    throw new Error("Generated strip band is stale; regenerate from the seed.");
  }
  return true;
}

// Server-side/offline only. Never import this module or its generated DATA into a SPA.
export function readStripSource() {
  const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
  return { route: read("route.geojson"), segments: read("segments.geojson"),
    facilities: read("facilities.geojson"), bowtie: read("bowtie-a.json") };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const file = new URL("strip-band.json", import.meta.url);
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: node data/synthetic/dl-01/strip-band.mjs [--check]");
  }
  if (args[0] === "--check") checkStripBand(file, readStripSource());
  else writeFileSync(file, serializeStripBand(buildStripBand(readStripSource())), { mode: 0o600 });
}
