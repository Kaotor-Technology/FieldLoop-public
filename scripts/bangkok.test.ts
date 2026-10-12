import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dataDirectory = "data/synthetic/bangkok";
function runModule<T>(code: string): T {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" })) as T;
}

describe("Bangkok static OSM extract (FL-136)", () => {
  it("reproduces both committed GeoJSON files offline from hash-checked snapshots", () => {
    const directory = mkdtempSync(join(tmpdir(), "fieldloop-bangkok-"));
    try {
      execFileSync(process.execPath, [`${dataDirectory}/extract.mjs`, "--output-dir", directory]);
      for (const file of ["canals.geojson", "districts.geojson"]) {
        expect(readFileSync(join(directory, file), "utf8")).toBe(readFileSync(`${dataDirectory}/${file}`, "utf8"));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps real map provenance and does not present it as simulated infrastructure", () => {
    const result = runModule<{ canals: number; districts: number[]; labels: boolean }>(`
      import { buildExtract, readSources } from './data/synthetic/bangkok/extract.mjs';
      const { canals, districts } = buildExtract(readSources());
      console.log(JSON.stringify({ canals: canals.features.length, districts: districts.features.map(f=>f.properties.osm_id),
        labels: [...canals.features,...districts.features].every(f=>f.properties.simulated===false && f.properties.classification==='PUBLIC'
          && f.properties.attribution==='© OpenStreetMap contributors' && f.properties.licence==='ODbL-1.0'
          && f.properties.source.startsWith('https://www.openstreetmap.org/')) }));
    `);
    expect(result).toEqual({ canals: 168, districts: [2938032, 2939952], labels: true });
  });

  it("joins reversed ways and places holes in their containing outer ring", () => {
    const result = runModule<{ type: string; rings: number; contains: boolean[] }>(`
      import { boundaryGeometry, pointInArea } from './data/synthetic/bangkok/extract.mjs';
      const source={elements:[
        ...[[0,0],[4,0],[4,4],[0,4],[1,1],[1,2],[2,2],[2,1]].map(([lon,lat],i)=>({type:'node',id:i+1,lon,lat})),
        {type:'way',id:10,nodes:[1,2,3]}, {type:'way',id:11,nodes:[1,4,3]}, {type:'way',id:12,nodes:[5,6,7,8,5]},
        {type:'relation',id:20,tags:{boundary:'administrative'},members:[{type:'way',ref:10,role:'outer'},
          {type:'way',ref:11,role:'outer'},{type:'way',ref:12,role:'inner'}]}]};
      const area=boundaryGeometry(source,20);
      console.log(JSON.stringify({type:area.type,rings:area.coordinates[0].length,contains:[[3,3],[1.5,1.5],[5,5]].map(p=>pointInArea(p,area))}));
    `);
    expect(result).toEqual({ type: "MultiPolygon", rings: 2, contains: [true, false, false] });
  });

  it("rejects incomplete boundaries and failed Overpass responses", () => {
    const errors = runModule<string[]>(`
      import { boundaryGeometry, normalizeSource, readSources } from './data/synthetic/bangkok/extract.mjs';
      const source=readSources()[1]; source.elements=source.elements.filter(e=>e.type!=='node');
      const errors=[];
      for(const fn of [()=>boundaryGeometry(source,2938032),()=>normalizeSource({remark:'timed out',elements:[]})]) {
        try {fn();} catch(e){errors.push(e.message);}
      }
      console.log(JSON.stringify(errors));
    `);
    expect(errors).toEqual(["OSM geometry has a missing or invalid coordinate.", "OSM source is empty or reports an error."]);
  });
});
