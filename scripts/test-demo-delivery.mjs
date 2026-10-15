// Local transport/OIDC fixtures only; Scenario, emitter, Worker HTTP and PostgreSQL are real.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
import {Kysely,PostgresDialect,sql} from 'kysely';
import pg from 'pg';
import {domainPackRecordId,loadDemoDomainPacks} from '../apps/api/dist/domain-packs.js';
import {PostgresWorkerStore} from '../apps/signal-worker/dist/postgres-store.js';
import {buildApp} from '../apps/signal-worker/dist/app.js';
import {deterministicUuid} from '../db/seed/common.mjs';
import {loadSeed as dlSeed} from '../db/seed/dl-01/seed.mjs';
import {loadSeed as floodSeed} from '../db/seed/bangkok/seed.mjs';
import {buildDataset as dlData} from '../data/synthetic/dl-01/generate.mjs';
import {buildDataset as floodData} from '../data/synthetic/bangkok/generate.mjs';
const container=`fieldloop-demo-bridge-${process.pid}`;
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:120000}).trim();
const waitForDatabase=async(database,attempts=60,pause=()=>setTimeout(500))=>{
 for(let attempt=0;attempt<attempts;attempt++){
  try{assert.equal(docker('exec','-e','PGPASSWORD=fixture',container,'psql','-X','-h','127.0.0.1','-U','postgres','-d',database,'-tAc','SELECT 1'),'1');return;}
  catch{if(attempt+1<attempts)await pause();}
 }
 throw new Error(`Fixture database ${database} not ready after ${attempts} attempts`);
};
let database,application,guardrail,app,finalRun;
const workerRole='fl-v2-signal-worker-dev@example-project.iam';
const intervals={'mock-historian':{months:3},'mock-patrol':{months:3},'mock-hydro':60,'mock-pumps':60};
const packs=await loadDemoDomainPacks();
let producerDatabaseUrl;
const producerCommand=process.env.FIELDLOOP_DEMO_PRODUCER_COMMAND
 ? JSON.parse(process.env.FIELDLOOP_DEMO_PRODUCER_COMMAND) : ['uv','run','--locked','--all-packages','python','scripts/test-demo-delivery.py'];
assert.ok(Array.isArray(producerCommand)&&producerCommand.length&&producerCommand.every(arg=>typeof arg==='string'));
const produce=(scenario,action)=>JSON.parse(execFileSync(producerCommand[0],[...producerCommand.slice(1),scenario,action],{
 encoding:'utf8',timeout:120000,env:{...process.env,FIELDLOOP_ENV:'local',FIELDLOOP_DATABASE_URL:producerDatabaseUrl}}));
const signals=result=>result.messages.map(m=>JSON.parse(Buffer.from(m.data,'base64').toString('utf8')));
const semantic=items=>items.map(item=>Object.fromEntries(Object.entries(item).filter(([key])=>!['id','simulationRunId'].includes(key))));
try {
 docker('run','--rm','-d','--name',container,...(process.env.FIELDLOOP_DEMO_DOCKER_NETWORK?['--network',process.env.FIELDLOOP_DEMO_DOCKER_NETWORK]:[]),
  '-e','POSTGRES_PASSWORD=fixture','-e','POSTGRES_DB=fieldloop_dev','-p','127.0.0.1::5432','fieldloop-db-test:pg16');
 await waitForDatabase('fieldloop_dev');
 // A ready server is insufficient when the intended database does not exist.
 assert.equal(docker('exec',container,'pg_isready','-q','-h','127.0.0.1','-U','postgres'),'');
 await assert.rejects(waitForDatabase('fieldloop_readiness_probe',2,async()=>{}),/not ready after 2 attempts/);
 let retries=0;
 await waitForDatabase('fieldloop_readiness_probe',2,async()=>{
  retries++;docker('exec',container,'psql','-U','postgres','-d','postgres','-c','CREATE DATABASE fieldloop_readiness_probe');
 });
 assert.equal(retries,1,'probe must retry until the target database exists');
 docker('exec',container,'psql','-U','postgres','-d','postgres','-c','DROP DATABASE fieldloop_readiness_probe');
 docker('exec',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','fieldloop_dev','-c',`CREATE ROLE "${workerRole}" NOLOGIN`);
 const migrations=readdirSync('db/migrations').filter(f=>f.endsWith('.sql')).sort()
  .map(f=>readFileSync(`db/migrations/${f}`,'utf8').split('-- migrate:down')[0]).join('\n');
 execFileSync('docker',['exec','-i',container,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','fieldloop_dev'],{input:migrations,timeout:120000});
 const port=docker('port',container,'5432').split(':').at(-1);
 const connectionString=`postgres://postgres:fixture@127.0.0.1:${port}/fieldloop_dev`;
 producerDatabaseUrl=process.env.FIELDLOOP_DEMO_PRODUCER_HOST?`postgres://postgres:fixture@${container}:5432/fieldloop_dev?sslmode=disable`:connectionString;
 database=new Kysely({dialect:new PostgresDialect({pool:new pg.Pool({connectionString})})});
 application=new Kysely({dialect:new PostgresDialect({pool:new pg.Pool({connectionString,options:`-c role=${workerRole}`,max:5})})});
 guardrail=new Kysely({dialect:new PostgresDialect({pool:new pg.Pool({connectionString,options:'-c role=fieldloop_guardrail_dev',max:1})})});
 for(const scenario of ['cp-rectifier-failure','bangkok-storm']){
  const org='demo-bridge-'+scenario;
  await dlSeed(database,dlData(),org);await floodSeed(database,floodData(),org);
  for(const {content} of packs) for(const rule of content.signalRules.filter(r=>r.condition.kind==='signal')){
   await sql`INSERT INTO app.signal_rule(id,org_id,pack,condition,target_barrier_selector,simulated,classification,created_by)
    VALUES(${domainPackRecordId(org,content.id,'signal_rule',rule.id)}::uuid,${org},${content.id},
     ${JSON.stringify({...rule.condition,ruleId:rule.id,packVersion:content.version,effect:rule.effect})}::jsonb,
     ${JSON.stringify(rule.targetBarrierSelector)}::jsonb,true,'CONFIDENTIAL','demo-bridge-fixture')`.execute(database);
  }
  const snapshot=async()=>(await sql`SELECT id,health FROM app.barrier WHERE org_id=${org} ORDER BY id`.execute(database)).rows;
  const before=await snapshot();const store=new PostgresWorkerStore(application,org,intervals);await store.initialize();
  const ingest=store.ingest.bind(store);store.ingest=async signal=>{try{return await ingest(signal);}catch(error){console.error("ACTUAL_STORE_ERROR",error);throw error;}};
  const published=[];
  const runtime={store,identity:{verify:async token=>assert.equal(token,'fixture')},audience:'https://worker.example.test',
   pushEmail:'push@example.test',schedulerEmail:'scheduler@example.test',subscription:'projects/fixture/subscriptions/signals-local',
   orgId:org,environment:'local',simulatedOnly:true,close:async()=>{},publish:async event=>published.push(event)};
  app=buildApp(runtime);
  const deliver=async result=>{
   for(const [index,message] of result.messages.entries()){
    assert.equal(message.topic,'signals');
    const payload={subscription:runtime.subscription,message:{messageId:`local-${result.run.id}-${index}`,data:message.data,attributes:message.attributes}};
    const response=await app.inject({method:'POST',url:'/internal/pubsub/signals',headers:{authorization:'Bearer fixture'},payload});
    assert.equal(response.statusCode,204,response.body);
   }
  };
  const first=produce(scenario,'run');const original=signals(first);
  assert.equal(original.length,scenario==='cp-rectifier-failure'?8:13);
  assert.ok(original.every(s=>s.orgId===org&&s.simulated&&s.simulationRunId===first.run.id&&s.payload.sandbox));
  await assert.rejects(sql`UPDATE app.simulation_run SET seed=seed WHERE id=${first.run.id}::uuid`.execute(application),error=>error.code==='42501','worker has no direct SimulationRun write privilege');
  await sql`SELECT app.assert_simulation_run(${first.run.id}::uuid,${org})`.execute(application);
  await assert.rejects(sql`SELECT app.assert_simulation_run(${first.run.id}::uuid,'wrong-org')`.execute(application),error=>error.code==='23514');
  const guardrailBarrier=(await sql`SELECT id FROM app.barrier WHERE org_id=${org} ORDER BY id LIMIT 1`.execute(database)).rows[0].id;
  await guardrail.transaction().execute(async trx=>{
   await sql`SELECT set_config('app.simulation_run_id',${first.run.id},true)`.execute(trx);
   await sql`INSERT INTO app.evidence(org_id,barrier_id,kind,source,observed_at,simulated,classification,created_by)
    VALUES(${org},${guardrailBarrier}::uuid,'guardrail.intercept','guardrail',clock_timestamp(),true,'CONFIDENTIAL','guardrail-fixture')`.execute(trx);
  });
  await assert.rejects(sql`UPDATE app.simulation_run SET seed=seed WHERE id=${first.run.id}::uuid`.execute(guardrail),error=>error.code==='42501');
  await assert.rejects(sql`SELECT app.assert_simulation_run(${first.run.id}::uuid,'wrong-org')`.execute(guardrail),error=>error.code==='23514');
  await deliver(first);
  const persisted=(await sql`SELECT payload FROM app.current_signal WHERE org_id=${org} ORDER BY payload->>'id'`.execute(database)).rows.map(r=>r.payload);
  assert.deepEqual(persisted,original.toSorted((a,b)=>a.id.localeCompare(b.id)),'worker stores untouched producer payloads');
  const proposals=async id=>(await sql`SELECT proposed_health,status,simulation_run_id FROM app.health_proposal
   WHERE simulation_retired_at IS NULL AND org_id=${org} AND signal_receipt_id=${id}::uuid`.execute(database)).rows;
  if(scenario==='cp-rectifier-failure'){
   // AC1: inspect this exact seeded survey, independently of newer Signal Evidence.
   const surveyId=deterministicUuid(`fieldloop:dl-01:${org}:evidence:cp-survey-2025`);
   const surveys=(await sql`SELECT e.id,e.kind,e.source,e.observed_at,
    b.evidence_interval=INTERVAL '12 months' AS annual_interval,
    e.observed_at+b.evidence_interval AS due_at,r.clock,
    e.observed_at+b.evidence_interval < ${first.startsAt}::timestamptz AS expired_at_start,
    e.observed_at+b.evidence_interval < r.clock AS expired_at_completion
    FROM app.evidence e JOIN app.barrier b ON b.id=e.barrier_id AND b.org_id=e.org_id
    JOIN app.simulation_run r ON r.id=${first.run.id}::uuid AND r.org_id=e.org_id
    WHERE e.id=${surveyId}::uuid AND e.org_id=${org} AND e.simulation_retired_at IS NULL
     AND b.code='cathodic-protection'`.execute(database)).rows;
   assert.equal(surveys.length,1,'the exact current seeded CP survey must exist');
   const survey=surveys[0];
   assert.equal(survey.kind,'performance_check');assert.equal(survey.source,'manual');
   assert.equal(survey.observed_at.toISOString(),'2025-10-13T00:00:00.000Z');
   assert.equal(survey.annual_interval,true);
   assert.equal(survey.due_at.toISOString(),'2026-10-13T00:00:00.000Z');
   assert.ok(Date.parse(first.startsAt)<survey.due_at.getTime());
   assert.equal(survey.expired_at_start,false);assert.equal(survey.expired_at_completion,true);
   assert.ok(survey.due_at.getTime()<survey.clock.getTime());

   const zero=original.find(s=>s.tag==='DL-01.rectifier.output'&&s.value===0);assert.ok(zero);
   const result=await proposals(zero.id);assert.equal(result.length,1);assert.equal(result[0].proposed_health,'failed');assert.equal(result[0].status,'open');
   assert.ok(original.some(s=>s.tag.endsWith('work_order.overdue')&&s.value===1),'actual authored overdue observation delivered');
  }else{
   const rain=original.find(s=>s.tag==='rain.accumulation.24h'&&s.value===144);
   const pump=original.find(s=>s.tag==='pump.power'&&s.value==='lost');assert.ok(rain&&pump);
   assert.equal(Date.parse(rain.observedAt)-Date.parse(first.startsAt),7200000);
   assert.equal(Date.parse(pump.observedAt)-Date.parse(first.startsAt),7201000);
   assert.equal((await proposals(rain.id)).length,3);assert.equal((await proposals(pump.id)).length,1);
  }
  assert.deepEqual(await snapshot(),before,'signals propose; never auto-apply Barrier Health');
  assert.ok(!(await sql`SELECT current_setting('app.simulation_run_id',true) run`.execute(application)).rows[0].run,'run context is transaction-local');
  const eventCount=published.length;await deliver(first);assert.equal(published.length,eventCount,'redelivery does not republish domain effects');
  const reset=produce(scenario,'reset');assert.notEqual(reset.run.id,first.run.id);assert.equal(reset.messages.length,0);
  assert.equal((await sql`SELECT count(*)::int n FROM app.current_health_proposal WHERE org_id=${org}`.execute(database)).rows[0].n,0);
  assert.equal((await sql`SELECT count(*)::int n FROM app.current_signal WHERE org_id=${org}`.execute(database)).rows[0].n,0);
  assert.deepEqual(await snapshot(),before,'real reset restores the captured domain baseline');
  await assert.rejects(sql`SELECT app.assert_simulation_run(${first.run.id}::uuid,${org})`.execute(application),error=>error.code==='23514','retired run cannot pass run fence');
  await assert.rejects(sql`SELECT app.assert_simulation_run(${first.run.id}::uuid,${org})`.execute(guardrail),error=>error.code==='23514');
  const replay=produce(scenario,'replay');finalRun={id:replay.run.id,org};const replaySignals=signals(replay);
  assert.deepEqual(semantic(replaySignals),semantic(original),'seed75 / speed60 replay preserves Scenario observations');
  assert.ok(replaySignals.every(s=>s.simulationRunId===reset.run.id&&!original.some(o=>o.id===s.id)));
  await deliver(replay);assert.deepEqual(await snapshot(),before);
  assert.equal((await sql`SELECT count(*)::int n FROM app.current_signal WHERE org_id=${org}`.execute(database)).rows[0].n,original.length);
  console.log(`PASS ${scenario}: ${original.length} real producer envelopes -> Worker HTTP/Postgres; proposals, provenance, idempotency, reset and replay`);
  await app.close();app=undefined;
 }
 const fence=readFileSync('db/migrations/20261015000001_simulation_run_fence.sql','utf8').split('-- migrate:down');
 await sql.raw(fence[1]).execute(database);
 assert.equal((await sql`SELECT prosecdef FROM pg_proc WHERE oid='app.assert_simulation_run(uuid,text)'::regprocedure`.execute(database)).rows[0].prosecdef,false,'down restores invoker rights');
 await assert.rejects(sql`SELECT app.assert_simulation_run('00000000-0000-0000-0000-000000000000'::uuid,'missing')`.execute(application),error=>error.code==='42501','down restores prior worker locking permission failure');
 await sql.raw(fence[0]).execute(database);
 await sql`SELECT app.assert_simulation_run(${finalRun.id}::uuid,${finalRun.org})`.execute(application);
 await sql`SELECT app.assert_simulation_run(${finalRun.id}::uuid,${finalRun.org})`.execute(guardrail);
 console.log('PASS forward/down migration; worker direct UPDATE denied; wrong-org and retired runs rejected');
 console.log('LIMITATION: local in-memory transport, fixture identity verifier and outbound collector; not Google OIDC, PubSub or deployment proof.');
}finally{if(app)await app.close();if(guardrail)await guardrail.destroy();if(application)await application.destroy();if(database)await database.destroy();try{docker('rm','-f',container);}catch{ /* Preserve the original test failure if container cleanup also fails. */ }}
