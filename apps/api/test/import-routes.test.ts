import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort, type CurrentUser } from "../src/auth/service.js";
import { ImportError } from "../src/imports/parser.js";
import type { ImportPort } from "../src/imports/store.js";

const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
function fixture() {
  const user:CurrentUser={sub:"synthetic-importer",orgId:"synthetic-org",roles:["fieldloop.operator"],persona:"Integrity Engineer",clearance:"HIGHLY_RESTRICTED",csrfToken:"fixture-csrf",authTime:new Date()};
  const auth:AuthServicePort={getCurrentUser:async cookie=>{if(cookie!=="valid") throw new AuthError("Session required",401);return user;},startLogin:async()=>new URL("https://example.test"),startReauthentication:async()=>new URL("https://example.test"),completeLogin:async()=>{throw new Error("unused");},issueInternalUserToken:async()=>{throw new Error("unused");},logout:async()=>new URL("https://example.test"),backchannelLogout:async()=>{},jwks:async()=>({keys:[]})};
  const imports:ImportPort={create:vi.fn(),preview:vi.fn(),map:vi.fn(),command:vi.fn(),options:vi.fn(async()=>({assets:[],barriers:[]}))};
  const app=buildApp({auth,imports});apps.push(app);
  return {app,user,imports,headers:{cookie:"fl_session=valid","x-csrf-token":"fixture-csrf","idempotency-key":"synthetic-import-key"}};
}
it("requires cookie, CSRF and an operator role for upload and rejects agent identities",async()=>{
  const {app,user,imports,headers}=fixture(),payload={format:"kml",contentBase64:Buffer.from("synthetic").toString("base64")};
  expect((await app.inject({method:"POST",url:"/api/v1/imports",payload})).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url:"/api/v1/imports",payload,headers:{cookie:headers.cookie}})).statusCode).toBe(403);
  user.roles=["fieldloop.viewer"];
  expect((await app.inject({method:"POST",url:"/api/v1/imports",payload,headers})).statusCode).toBe(403);
  user.roles=["fieldloop.operator"];user.sub="agent:synthetic";
  expect((await app.inject({method:"POST",url:"/api/v1/imports",payload,headers})).statusCode).toBe(403);
  expect(imports.create).not.toHaveBeenCalled();
});
it("validates upload encoding and passes identity and idempotency to persistence",async()=>{
  const {app,user,imports,headers}=fixture();
  vi.mocked(imports.create).mockResolvedValue({id:"00000000-0000-4000-8000-000000000100",status:"preview",version:1,classification:"INTERNAL",fileHash:"synthetic-hash",createdAt:new Date().toISOString(),mapping:null,points:[]});
  const response=await app.inject({method:"POST",url:"/api/v1/imports",headers,payload:{format:"kml",contentBase64:"c3ludGhldGlj"}});
  expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(imports.create).toHaveBeenCalledWith(user,Buffer.from("synthetic"),"kml",headers["idempotency-key"]);
  const invalid=await app.inject({method:"POST",url:"/api/v1/imports",headers,payload:{format:"kml",contentBase64:"not base64"}});
  expect(invalid.statusCode).toBe(400);expect(invalid.headers["content-type"]).toContain("application/problem+json");
});
it("validates versions, UUIDs and snap tolerance before mapping or command",async()=>{
  const {app,imports,headers}=fixture(),id="00000000-0000-4000-8000-000000000100";
  expect((await app.inject({method:"PUT",url:`/api/v1/imports/${id}/mapping`,headers,payload:{version:1,mapping:{assetId:id,toleranceMetres:-1,nameField:"name",descriptionField:"",categoryField:"folder",target:"facility",barrierId:null}}})).statusCode).toBe(400);
  expect((await app.inject({method:"POST",url:`/api/v1/imports/${id}:commit`,headers,payload:{version:0}})).statusCode).toBe(400);
  expect((await app.inject({method:"GET",url:"/api/v1/imports/not-uuid/preview",headers})).statusCode).toBe(400);
  expect(imports.map).not.toHaveBeenCalled();expect(imports.command).not.toHaveBeenCalled();
});
it("rejects array-valued format and target enums before calling persistence",async()=>{
  const {app,imports,headers}=fixture(),id="00000000-0000-4000-8000-000000000100";
  const upload=await app.inject({method:"POST",url:"/api/v1/imports",headers,payload:{format:["kml"],contentBase64:"c3ludGhldGlj"}});
  expect(upload.statusCode).toBe(400);
  const mapped=await app.inject({method:"PUT",url:`/api/v1/imports/${id}/mapping`,headers,payload:{version:1,mapping:{assetId:id,toleranceMetres:50,nameField:"name",descriptionField:"",categoryField:"folder",target:["facility"],barrierId:null}}});
  expect(mapped.statusCode).toBe(400);
  const missingBarrier=await app.inject({method:"PUT",url:`/api/v1/imports/${id}/mapping`,headers,payload:{version:1,mapping:{assetId:id,toleranceMetres:50,nameField:"name",descriptionField:"",categoryField:"folder",target:"evidence",barrierId:null}}});
  expect(missingBarrier.statusCode).toBe(400);expect(missingBarrier.json().code).toBe("validation_failed");
  const longField=await app.inject({method:"PUT",url:`/api/v1/imports/${id}/mapping`,headers,payload:{version:1,mapping:{assetId:id,toleranceMetres:50,nameField:"x".repeat(201),descriptionField:"",categoryField:"folder",target:"facility",barrierId:null}}});
  expect(longField.statusCode).toBe(400);
  expect(imports.create).not.toHaveBeenCalled();expect(imports.map).not.toHaveBeenCalled();
});

it("maps internal import errors to canonical RFC Problem codes",async()=>{
  const {app,imports,headers}=fixture(),id="00000000-0000-4000-8000-000000000100";
  vi.mocked(imports.create).mockRejectedValueOnce(new ImportError(400,"invalid_kml"));
  const invalid=await app.inject({method:"POST",url:"/api/v1/imports",headers,payload:{format:"kml",contentBase64:"c3ludGhldGlj"}});
  expect(invalid.statusCode).toBe(400);expect(invalid.json().code).toBe("validation_failed");
  vi.mocked(imports.create).mockRejectedValueOnce(new ImportError(413,"upload_too_large"));
  const oversized=await app.inject({method:"POST",url:"/api/v1/imports",headers,payload:{format:"kml",contentBase64:"c3ludGhldGlj"}});
  expect(oversized.statusCode).toBe(413);expect(oversized.json().code).toBe("payload_too_large");
  vi.mocked(imports.command).mockRejectedValueOnce(new ImportError(409,"rollback_conflict"));
  const conflict=await app.inject({method:"POST",url:`/api/v1/imports/${id}:rollback`,headers,payload:{version:1}});
  expect(conflict.statusCode).toBe(409);expect(conflict.json().code).toBe("conflict");
});
