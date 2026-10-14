import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import type { CurrentUser } from "../src/auth/service.js";
import { PostgresImportStore, type ImportMapping } from "../src/imports/store.js";

const url = process.env["FIELDLOOP_IMPORT_TEST_DATABASE_URL"];
describe.skipIf(!url)("KML imports against migrated PostGIS", () => {
  let pool: Pool, db: Kysely<Record<string,never>>, store: PostgresImportStore;
  beforeAll(() => {pool=new Pool({connectionString:url,max:5});db=new Kysely({dialect:new PostgresDialect({pool})});store=new PostgresImportStore(db);});
  afterAll(async () => {await db?.destroy();});
  async function fixture() {
    const orgId=randomUUID(),assetId=randomUUID(),barrierId=randomUUID(),bowtieId=randomUUID(),threatId=randomUUID();
    const user:CurrentUser={sub:"synthetic-importer",orgId,roles:["fieldloop.operator"],persona:"Integrity Engineer",clearance:"HIGHLY_RESTRICTED",csrfToken:"csrf",authTime:new Date()};
    await pool.query("INSERT INTO app.organisation (id,org_id,name,import_area,simulated,classification) VALUES ($1::uuid,$1::text,'Synthetic organisation',ST_Multi(ST_GeomFromText('POLYGON((99 19,101 19,101 21,99 21,99 19))',4326)),true,'INTERNAL')",[orgId]);
    await pool.query("INSERT INTO app.asset (id,org_id,type,geom,attributes,simulated,classification) VALUES ($1,$2,'pipeline',ST_GeomFromText('LINESTRING(100 20,100 20.01)',4326),'{\"name\":\"Synthetic route\"}',true,'HIGHLY_RESTRICTED')",[assetId,orgId]);
    await pool.query("INSERT INTO app.segment (org_id,asset_id,chainage_from,chainage_to,geom,simulated,classification) VALUES ($1,$2,0,1000,ST_GeomFromText('LINESTRING(100 20,100 20.01)',4326),true,'HIGHLY_RESTRICTED')",[orgId,assetId]);
    await pool.query("INSERT INTO app.bowtie(id,org_id,hazard,top_event,simulated,classification) VALUES($1,$2,'Synthetic hazard','Synthetic event',true,'CONFIDENTIAL')",[bowtieId,orgId]);
    await pool.query("INSERT INTO app.bowtie_asset(bowtie_id,asset_id,org_id,simulated,classification) VALUES($1,$2,$3,true,'CONFIDENTIAL')",[bowtieId,assetId,orgId]);
    await pool.query("INSERT INTO app.threat(id,bowtie_id,org_id,simulated,classification) VALUES($1,$2,$3,true,'CONFIDENTIAL')",[threatId,bowtieId,orgId]);
    await pool.query("INSERT INTO app.barrier(id,org_id,name,type,side,health,simulated,classification) VALUES($1,$2,'Synthetic patrol','organisational','preventive','healthy',true,'CONFIDENTIAL')",[barrierId,orgId]);
    await pool.query("INSERT INTO app.barrier_path(org_id,threat_id,barrier_id,position,simulated,classification) VALUES($1,$2,$3,0,true,'CONFIDENTIAL')",[orgId,threatId,barrierId]);
    const mapping:ImportMapping={assetId,toleranceMetres:50,nameField:"name",descriptionField:"",categoryField:"folder",target:"evidence",barrierId};
    return {user,assetId,barrierId,mapping};
  }
  const content=(coordinates="100,20.005")=>Buffer.from(`<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>Synthetic point</name><Point><coordinates>${coordinates}</coordinates></Point></Placemark></kml>`);
  it("resumes mapping, snaps to Chainage, commits Evidence and rolls back only the batch",async()=>{
    const {user,barrierId,mapping}=await fixture();
    expect((await store.options(user)).barriers).toEqual(expect.arrayContaining([expect.objectContaining({id:barrierId})]));
    const created=await store.create(user,content(),"kml",randomUUID());
    const mapped=await store.map(user,created.id,created.version,mapping);
    expect(mapped.classification).toBe("HIGHLY_RESTRICTED");
    expect(mapped.points[0]?.distanceMetres).toBeCloseTo(0,3);
    expect(mapped.points[0]?.chainageMetres).toBeCloseTo(500,2);
    expect(mapped.points[0]?.flags).toEqual([]);
    expect(await store.preview(user,mapped.id)).toEqual(mapped);
    const key=randomUUID();
    const committed=await store.command(user,mapped.id,mapped.version,"commit",key);
    expect(await store.command(user,mapped.id,mapped.version,"commit",key)).toEqual(committed);
    const evidence=await pool.query("SELECT barrier_id,simulated,classification FROM app.evidence WHERE org_id=$1",[user.orgId]);
    expect(evidence.rows).toEqual([{barrier_id:barrierId,simulated:true,classification:"HIGHLY_RESTRICTED"}]);
    expect((await pool.query("SELECT health FROM app.barrier WHERE id=$1",[barrierId])).rows).toEqual([{health:"healthy"}]);
    await expect(store.map(user,mapped.id,mapped.version,mapping)).rejects.toMatchObject({status:409});
    const rolledBack=await store.command(user,mapped.id,committed.version,"rollback",randomUUID());
    expect(rolledBack.status).toBe("rolled_back");
    expect((await pool.query("SELECT count(*)::int AS count FROM app.evidence WHERE org_id=$1",[user.orgId])).rows[0]?.count).toBe(0);
    expect((await pool.query("SELECT action FROM app.audit_event WHERE org_id=$1 ORDER BY created_at",[user.orgId])).rows).toEqual([{action:"import.commit"},{action:"import.rollback"}]);
  });
  it("flags outside tolerance and area, blocks duplicates and isolates tenants and uploader",async()=>{
    const {user,mapping}=await fixture();
    const created=await store.create(user,content("102,22"),"kml",randomUUID());
    const mapped=await store.map(user,created.id,created.version,mapping);
    expect(mapped.points[0]?.chainageMetres).toBeNull();
    expect(mapped.points[0]?.flags).toEqual(["outside_snap_tolerance","outside_organisation_area"]);
    await expect(store.preview({...user,orgId:randomUUID()},mapped.id)).rejects.toMatchObject({status:404});
    await expect(store.preview({...user,sub:"other-uploader"},mapped.id)).rejects.toMatchObject({status:404});
    await expect(store.preview({...user,clearance:"PUBLIC"},mapped.id)).rejects.toMatchObject({status:404});
    await store.command(user,mapped.id,mapped.version,"commit",randomUUID());
    const duplicate=await store.create(user,content("102,22"),"kml",randomUUID());
    const second=await store.map(user,duplicate.id,duplicate.version,mapping);
    expect(second.points[0]?.flags).toContain("duplicate");
    await expect(store.command(user,second.id,second.version,"commit",randomUUID())).rejects.toMatchObject({status:409});
  });
  it("imports a Facility and protects upload idempotency",async()=>{
    const {user,mapping}=await fixture(),key=randomUUID();
    const created=await store.create(user,content(),"kml",key);
    await expect(store.create({...user,clearance:"INTERNAL"},content(),"kml",key)).rejects.toMatchObject({status:403});
    expect((await store.create(user,content(),"kml",key)).id).toBe(created.id);
    await expect(store.create(user,content("100,20.1"),"kml",key)).rejects.toMatchObject({code:"idempotency_key_reused"});
    const mapped=await store.map(user,created.id,created.version,{...mapping,target:"facility",barrierId:null});
    const committed=await store.command(user,mapped.id,mapped.version,"commit",randomUUID());
    expect((await pool.query("SELECT parent_id,attributes->>'name' AS name FROM app.asset WHERE org_id=$1 AND type='facility'",[user.orgId])).rows).toEqual([{parent_id:mapping.assetId,name:"Synthetic point"}]);
    await store.command(user,mapped.id,committed.version,"rollback",randomUUID());
    expect((await pool.query("SELECT id FROM app.asset WHERE org_id=$1",[user.orgId])).rows).toEqual([{id:mapping.assetId}]);
  });
  it("rejects stale Asset geometry and concurrent duplicate commits",async()=>{
    const {user,mapping}=await fixture();
    const first=await store.create(user,content(),"kml",randomUUID());
    const mapped=await store.map(user,first.id,first.version,mapping);
    await pool.query("UPDATE app.segment SET chainage_to=2000 WHERE org_id=$1",[user.orgId]);
    await expect(store.command(user,mapped.id,mapped.version,"commit",randomUUID())).rejects.toMatchObject({code:"mapping_stale"});
    const remapped=await store.map(user,mapped.id,mapped.version,mapping);
    const second=await store.create(user,content(),"kml",randomUUID());
    const other=await store.map(user,second.id,second.version,mapping);
    const outcomes=await Promise.allSettled([store.command(user,remapped.id,remapped.version,"commit",randomUUID()),store.command(user,other.id,other.version,"commit",randomUUID())]);
    expect(outcomes.filter(outcome=>outcome.status==="fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome=>outcome.status==="rejected")).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM app.evidence WHERE org_id=$1",[user.orgId])).rows[0]?.count).toBe(1);
  });
  it("maps linked Evidence without requiring a second connection",async()=>{
    const {user,mapping}=await fixture();
    const created=await store.create(user,content(),"kml",randomUUID());
    const singleDb=new Kysely<Record<string,never>>({dialect:new PostgresDialect({pool:new Pool({connectionString:url,max:1})})});
    try {expect((await new PostgresImportStore(singleDb).map(user,created.id,created.version,mapping)).status).toBe("mapped");}
    finally {await singleDb.destroy();}
  });
  it.each(["asset","barrier"] as const)("rejects a %s classification change while commit waits for its lock",async(dependency)=>{
    const {user,assetId,barrierId,mapping}=await fixture();
    await pool.query("UPDATE app.asset SET classification='INTERNAL' WHERE org_id=$1",[user.orgId]);
    await pool.query("UPDATE app.segment SET classification='INTERNAL' WHERE org_id=$1",[user.orgId]);
    await pool.query("UPDATE app.barrier SET classification='INTERNAL' WHERE org_id=$1",[user.orgId]);
    const created=await store.create(user,content(),"kml",randomUUID());
    const mapped=await store.map(user,created.id,created.version,dependency === "asset" ? {...mapping,target:"facility",barrierId:null} : mapping);
    expect(mapped.classification).toBe("INTERNAL");
    const locker=await pool.connect();
    const table=dependency === "asset" ? "app.asset" : "app.barrier";
    const targetId=dependency === "asset" ? assetId : barrierId;
    await locker.query("BEGIN");
    try {
      await locker.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[targetId]);
      const outcome=store.command(user,mapped.id,mapped.version,"commit",randomUUID()).then(()=>({status:200,code:"committed"}),error=>error as unknown);
      let waiting=false;
      for(let attempt=0;attempt<100;attempt++) {
        const blocked=await pool.query<{count:number}>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",[`%FROM ${table}%`]);
        if(blocked.rows[0]?.count) {waiting=true;break;}
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      expect(waiting).toBe(true);
      await locker.query(`UPDATE ${table} SET classification='CONFIDENTIAL' WHERE id=$1`,[targetId]);
      await locker.query("COMMIT");
      expect(await outcome).toMatchObject({status:409,code:"mapping_stale"});
      expect((await pool.query("SELECT count(*)::int AS count FROM app.kml_import_item WHERE kml_import_id=$1",[mapped.id])).rows[0]?.count).toBe(0);
    } finally {await locker.query("ROLLBACK");locker.release();}
  });
  it("preserves Geo References added after an Evidence import and rejects rollback atomically",async()=>{
    const {user,assetId,mapping}=await fixture();
    const created=await store.create(user,content(),"kml",randomUUID());
    const mapped=await store.map(user,created.id,created.version,mapping);
    const committed=await store.command(user,mapped.id,mapped.version,"commit",randomUUID());
    const evidence=(await pool.query<{id:string}>("SELECT id FROM app.evidence WHERE org_id=$1",[user.orgId])).rows[0];
    if(!evidence) throw new Error("Fixture Evidence missing");
    const laterReferenceId=randomUUID();
    await pool.query("INSERT INTO app.geo_reference(id,org_id,evidence_id,target_type,target_id,kind,geom,status,simulated,classification,created_by) VALUES($1,$2,$3,'asset',$4,'point',ST_SetSRID(ST_MakePoint(100,20.006),4326),'reviewed',true,'HIGHLY_RESTRICTED','synthetic-later-editor')",[laterReferenceId,user.orgId,evidence.id,assetId]);
    await expect(store.command(user,committed.id,committed.version,"rollback",randomUUID())).rejects.toMatchObject({status:409,code:"rollback_conflict"});
    expect((await pool.query("SELECT id FROM app.geo_reference WHERE id=$1",[laterReferenceId])).rows).toEqual([{id:laterReferenceId}]);
    expect((await pool.query("SELECT count(*)::int AS count FROM app.geo_reference WHERE org_id=$1",[user.orgId])).rows[0]?.count).toBe(2);
    expect((await store.preview(user,committed.id)).status).toBe("committed");
    expect((await pool.query("SELECT action FROM app.audit_event WHERE org_id=$1",[user.orgId])).rows).toEqual([{action:"import.commit"}]);
  });
});
