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
    const result = runModule<{ type: string; rings: number; contains: boolean[]; winding: boolean[] }>(`
      import { boundaryGeometry, pointInArea } from './data/synthetic/bangkok/extract.mjs';
      const source={elements:[
        ...[[0,0],[4,0],[4,4],[0,4],[1,1],[1,2],[2,2],[2,1]].map(([lon,lat],i)=>({type:'node',id:i+1,lon,lat})),
        {type:'way',id:10,nodes:[1,2,3]}, {type:'way',id:11,nodes:[1,4,3]}, {type:'way',id:12,nodes:[5,6,7,8,5]},
        {type:'relation',id:20,tags:{boundary:'administrative'},members:[{type:'way',ref:10,role:'outer'},
          {type:'way',ref:11,role:'outer'},{type:'way',ref:12,role:'inner'}]}]};
      const area=boundaryGeometry(source,20);
      const winding=area.coordinates[0].map(r=>r.reduce((s,p,i)=>{const q=r[(i+1)%r.length];return s+p[0]*q[1]-q[0]*p[1]},0)>0);
      console.log(JSON.stringify({type:area.type,rings:area.coordinates[0].length,contains:[[3,3],[1.5,1.5],[5,5]].map(p=>pointInArea(p,area)),winding}));
    `);
    expect(result).toEqual({ type: "MultiPolygon", rings: 2, contains: [true, false, false], winding: [true, false] });
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

describe("Bangkok simulated Assets (FL-137)", () => {
  it("reproduces labelled zones and Facilities and keeps each Facility inside its zone", () => {
    const result = runModule<{ codes: string[]; types: string[]; valid: boolean }>(`
      import { buildDataset } from './data/synthetic/bangkok/generate.mjs';
      import { pointInArea } from './data/synthetic/bangkok/extract.mjs';
      const { zones,facilities }=buildDataset();
      console.log(JSON.stringify({codes:facilities.features.map(f=>f.id),types:facilities.features.map(f=>f.properties.facility_type),
        valid:facilities.features.every(f=>f.properties.simulated===true && f.properties.label==='SYNTHETIC'
          && f.properties.classification==='HIGHLY_RESTRICTED' && pointInArea(f.geometry.coordinates,zones.features.find(z=>z.id===f.properties.zone_code).geometry))}));
    `);
    expect(result).toEqual({ codes: ["P-1", "P-3", "P-2", "G-1", "G-2", "S-R1", "S-L1", "S-T1"],
      types: ["pump", "pump", "pump", "gate", "gate", "rain_sensor", "level_sensor", "tide_sensor"], valid: true });
    const directory = mkdtempSync(join(tmpdir(), "fieldloop-bangkok-assets-"));
    try {
      execFileSync(process.execPath, [`${dataDirectory}/generate.mjs`, "--output-dir", directory]);
      for (const file of ["zones.geojson", "facilities.geojson"]) {
        expect(readFileSync(join(directory, file), "utf8")).toBe(readFileSync(`${dataDirectory}/${file}`, "utf8"));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("Bowtie D and Bangkok seed (FL-138)", () => {
  it("contains the complete PRD 6.1-D graph and labelled simulation parameters", () => {
    const result = runModule<{ names: string[]; severity: number[]; barriers: number; factors: string[]; overdue: boolean; metadata: Record<string, unknown> }>(`
      import { readBowtieSeed,validateDataset } from './db/seed/bangkok/seed.mjs';
      import { buildDataset } from './data/synthetic/bangkok/generate.mjs';
      const b=readBowtieSeed();validateDataset(buildDataset(),b);
      const backup=b.barriers.find(x=>x.id==='dual-power-generators');
      console.log(JSON.stringify({names:b.threats.map(t=>t.name),severity:b.consequences.map(c=>Math.max(...Object.values(c.severity))),
        barriers:b.barriers.length,factors:b.barriers.flatMap(x=>(x.degradationFactors??[]).map(f=>f.description)),
        overdue:backup.health==='degraded' && backup.evidence.every(e=>Date.parse(e.observedAt)<Date.parse(b.metadata.simulationStartsAt)-31*86400000),metadata:b.metadata}));
    `);
    expect(result.names).toEqual(["Heavy convective rainfall (> 60 mm/h)", "High Chao Phraya flow from upstream runoff", "High tide / storm surge", "Pump station outage (power loss)"]);
    expect(result.severity).toEqual([5, 5, 4, 4]);
    expect(result.barriers).toBe(15);
    expect(result.factors).toEqual(["Garbage-blocked drains", "Wall settlement / land subsidence", "Gate maintenance backlog", "Generator not tested"]);
    expect(result.overdue).toBe(true);
    expect(result.metadata).toMatchObject({ label: "SYNTHETIC", simulated: true, classification: "CONFIDENTIAL" });
  });

  it("binds values, keeps stable Organisation-specific IDs and scopes cleanup to its creator", () => {
    type Query = { sql: string; parameters: unknown[] };
    const preview = (orgId: string) => JSON.parse(execFileSync(process.execPath, ["db/seed/bangkok/seed.mjs", "--print-sql"], {
      encoding: "utf8", env: { ...process.env, FIELDLOOP_ORG_ID: orgId },
    })) as Query[];
    const orgId = "demo'); DROP TABLE app.asset; --";
    const queries = preview(orgId);
    expect(preview(orgId)).toEqual(queries);
    expect(preview("other-org")[0]?.parameters[0]).not.toBe(queries[0]?.parameters[0]);
    const inserts = queries.filter(q => q.sql.startsWith("insert"));
    expect(inserts).toHaveLength(297);
    expect(inserts.every(q => q.parameters.includes(true))).toBe(true);
    expect(queries.every(q => !q.sql.includes(orgId) && q.parameters.includes(orgId))).toBe(true);
    const deletes = queries.filter(q => q.sql.startsWith("delete"));
    expect(deletes.every(q => q.parameters.slice(0, 2).join() === [orgId, "seed:bangkok"].join())).toBe(true);
    expect(deletes.some(q => q.sql.includes('"organisation"'))).toBe(false);
  });

  it.each([
    ["delete b.metadata.classification", "metadata.classification"],
    ["d.facilities.features[0].properties.simulated=false", "must be labelled simulated"],
    ["d.facilities.features[0].geometry.coordinates=[100,14]", "outside its demo zone"],
    ["b.paths[0].barrierIds[0]='unknown'", "missing or wrong-side Barrier"],
    ["b.barriers[0].triad.effective.pass=false", "Validation Triad"],
    ["b.barriers[0].pfdBand=0.001", "PFD ceiling"],
    ["b.barriers[1].evidence[0].id=b.barriers[0].evidence[0].id", "Duplicate nested seed ID"],
    ["b.assetCodes=['unknown']", "scope must reference its demo zones"],
  ])("rejects malformed data before DB access: %s", (mutation, expected) => {
    const result = runModule<string>(`
      import { readBowtieSeed,loadSeed } from './db/seed/bangkok/seed.mjs';
      import { buildDataset } from './data/synthetic/bangkok/generate.mjs';
      const d=buildDataset(),b=readBowtieSeed();${mutation};
      const database={transaction(){throw new Error('unexpected DB access');}};
      try {await loadSeed(database,d,'test-org',b);} catch(e){console.log(JSON.stringify(e.message));}
    `);
    expect(result).toContain(expected);
    expect(result).not.toContain("unexpected DB access");
  });
});
