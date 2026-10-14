import { SaxesParser } from "saxes";
import { fromBuffer } from "yauzl";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024;
const MAX_POINTS = 1000;
export interface KmlPoint {
  longitude: number;
  latitude: number;
  attributes: Record<string, string>;
}
export class ImportError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const invalid = () => new ImportError(400, "invalid_kml");

// Plain text only: descriptions never retain tags, script bodies or external hrefs.
function plainText(value: string): string {
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]*>/g, "").split("").filter((character) => character.charCodeAt(0) >= 32 || "\t\n\r".includes(character)).join("").trim().slice(0, 2000);
}

export function parseKml(xml: string): KmlPoint[] {
  if (Buffer.byteLength(xml) > MAX_EXPANDED_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid();
  const parser = new SaxesParser({ xmlns: true });
  const stack: { name: string; text: string; key: string | undefined }[] = [];
  const points: KmlPoint[] = [];
  const folders: string[] = [];
  let attributes: Record<string, string> | undefined;
  let coordinates: { longitude: number; latitude: number } | undefined;
  let root = false;
  parser.on("opentag", (tag) => {
    if (stack.length > 64) throw invalid();
    if (!stack.length) {
      if (tag.local !== "kml" || tag.uri !== "http://www.opengis.net/kml/2.2") throw invalid();
      root = true;
    }
    if (tag.uri !== "http://www.opengis.net/kml/2.2" && tag.uri !== "") throw invalid();
    const name = tag.local;
    const keyAttribute = Object.values(tag.attributes).find((attribute) => attribute.local === "name");
    stack.push({ name, text: "", key: keyAttribute?.value });
    if (name === "Folder") folders.push("");
    if (name === "Placemark") {
      if (attributes) throw invalid();
      attributes = Object.create(null) as Record<string, string>;
      attributes["folder"] = folders.filter(Boolean).join(" / ");
      coordinates = undefined;
    }
  });
  const addText = (value: string) => {
    const current = stack.at(-1);
    if (current) current.text += value;
  };
  parser.on("text", addText);
  parser.on("cdata", addText);
  parser.on("closetag", () => {
    const current = stack.pop();
    if (!current) throw invalid();
    const parent = stack.at(-1);
    if (current.name === "name" && parent?.name === "Folder") folders[folders.length - 1] = plainText(current.text);
    if (attributes && !stack.some((entry) => entry.name === "NetworkLink")) {
      if (["name", "description"].includes(current.name) && parent?.name === "Placemark") attributes[current.name] = plainText(current.text);
      if (current.name === "value" && parent?.name === "Data" && parent.key) attributes[`ExtendedData.${plainText(parent.key)}`] = plainText(current.text);
      if (current.name === "SimpleData" && current.key) attributes[`ExtendedData.${plainText(current.key)}`] = plainText(current.text);
      if (current.name === "coordinates" && parent?.name === "Point") {
        if (coordinates) throw invalid();
        const text = current.text.trim();
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?,[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:,[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)?$/.test(text)) throw invalid();
        const [longitude, latitude] = text.split(",").map(Number);
        if (longitude === undefined || latitude === undefined || !Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw invalid();
        coordinates = { longitude, latitude };
      }
      if (current.name === "Placemark") {
        if (!coordinates || points.length >= MAX_POINTS) throw invalid();
        points.push({ ...coordinates, attributes });
        attributes = undefined;
      }
    }
    if (current.name === "Folder") folders.pop();
  });
  parser.on("error", () => { throw invalid(); });
  try { parser.write(xml).close(); } catch { throw invalid(); }
  if (!root || !points.length) throw invalid();
  return points;
}

export async function parseUpload(bytes: Buffer, format: "kml" | "kmz"): Promise<KmlPoint[]> {
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new ImportError(413, "upload_too_large");
  if (format === "kml") return parseKml(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(invalid()); return; }
      let expanded = 0, entries = 0;
      let document: Buffer | undefined;
      const fail = () => { zip.close(); reject(invalid()); };
      zip.on("error", fail);
      zip.on("entry", (entry) => {
        expanded += entry.uncompressedSize;
        if (++entries > 100 || expanded > MAX_EXPANDED_BYTES || entry.uncompressedSize > Math.max(1, entry.compressedSize) * 100 || (entry.generalPurposeBitFlag & 1)) { fail(); return; }
        if (!entry.fileName.toLowerCase().endsWith(".kml")) { zip.readEntry(); return; }
        if (document) { fail(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_EXPANDED_BYTES) { stream.destroy(); fail(); return; }
            chunks.push(chunk);
          });
          stream.on("end", () => { document = Buffer.concat(chunks); zip.readEntry(); });
        });
      });
      zip.on("end", () => {
        try {
          if (!document) throw invalid();
          resolve(parseKml(new TextDecoder("utf-8", { fatal: true }).decode(document)));
        } catch { reject(invalid()); }
      });
      zip.readEntry();
    });
  });
}
