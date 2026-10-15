import { expect, it, vi } from "vitest";
import { deflateRawSync } from "node:zlib";
import { MAX_UPLOAD_BYTES, parseKml, parseUpload } from "../src/imports/parser.js";

const wrap = (body: string) => `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${body}</Document></kml>`;
const point = `<Placemark><name>Synthetic finding</name><Point><coordinates>99.5,19.5,0</coordinates></Point></Placemark>`;

it("extracts WGS84 points, folders and ExtendedData as plain text", () => {
  const xml = wrap(`<Folder><name>Patrol</name><Placemark><name>Finding</name><description><![CDATA[<script>alert(1)</script><b>Fence</b><img src="https://example.test/a">]]></description><ExtendedData><Data name="owner"><value>Fixture</value></Data></ExtendedData><Point><coordinates>99.5,19.5</coordinates></Point></Placemark></Folder>`);
  expect(parseKml(xml)).toEqual([{ longitude: 99.5, latitude: 19.5, attributes: { folder: "Patrol", name: "Finding", description: "Fence", "ExtendedData.owner": "Fixture" } }]);
});
it("ignores NetworkLink and href without making any network request", () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  expect(parseKml(wrap(`<NetworkLink><Link><href>https://example.test/private</href></Link></NetworkLink>${point}`))).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore();
});
it.each([
  wrap(point.replace("99.5,19.5,0", "181,19")),
  wrap(point.replace("99.5,19.5,0", "99,91")),
  wrap(point.replace("99.5,19.5,0", "99,19 100,20")),
  wrap(point.replace("Point", "LineString").replace("</Point>", "</LineString>")),
  '<!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + wrap(point),
  wrap(point).replace("</Document>", "</Folder>"),
  wrap(point.repeat(1001)),
])("rejects invalid geometry, XML, entities and excessive points", (xml) => { expect(() => parseKml(xml)).toThrow(); });

// ZIP bytes are generated in memory; no confidential files or archive fixtures.
function archive(xml: string, declaredSize = Buffer.byteLength(xml)): Buffer {
  const content = deflateRawSync(Buffer.from(xml));
  const name = Buffer.from("doc.kml");
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(content.length, 18); local.writeUInt32LE(declaredSize, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(content.length, 20); central.writeUInt32LE(declaredSize, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, end]);
}
it("reads bounded compressed KML and rejects zip bombs, oversize and broken archives", async () => {
  expect(await parseUpload(archive(wrap(point)), "kmz")).toHaveLength(1);
  await expect(parseUpload(archive(wrap(point), 9 * 1024 * 1024), "kmz")).rejects.toThrow();
  await expect(parseUpload(archive(wrap(point.repeat(1000))), "kmz")).rejects.toThrow();
  await expect(parseUpload(Buffer.alloc(MAX_UPLOAD_BYTES + 1), "kml")).rejects.toThrow();
  await expect(parseUpload(Buffer.from("broken"), "kmz")).rejects.toThrow();
});
