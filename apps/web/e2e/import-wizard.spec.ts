import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { components } from "@fieldloop/contracts";

type Preview=components["schemas"]["ImportPreview"];
const id="00000000-0000-4000-8000-000000000100",assetId="00000000-0000-4000-8000-000000000101",barrierId="00000000-0000-4000-8000-000000000102";
test.beforeEach(async ({page,request})=>{
  await request.get("/test/reset");
  let state:Preview={id,status:"preview",version:1,classification:"HIGHLY_RESTRICTED",fileHash:"a".repeat(64),createdAt:"2026-10-14T00:00:00Z",mapping:null,
    points:[{id:assetId,longitude:100,latitude:20,attributes:{name:"Synthetic encroachment",description:"Synthetic fence",folder:"Patrol"},distanceMetres:null,chainageMetres:null,flags:["not_mapped"]}]};
  await page.route("**/api/v1/imports**",async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(request.method()!=="GET") expect(request.headers()["x-csrf-token"]).toBeTruthy();
    if(path.endsWith("/options")) return route.fulfill({json:{assets:[{id:assetId,name:"Synthetic route"}],barriers:[{id:barrierId,assetId,name:"Synthetic patrol"}]}});
    if(path.endsWith("/mapping")) {
      const body=request.postDataJSON();expect(body.version).toBe(state.version);
      state={...state,status:"mapped",version:state.version+1,mapping:body.mapping,points:state.points.map(point=>({...point,distanceMetres:5,chainageMetres:500,flags:[]}))};
    }
    if(path.endsWith(":commit")) {
      expect(request.headers()["idempotency-key"]).toBe(`${id}:commit`);
      expect(state.mapping?.barrierId).toBe(barrierId);
      state={...state,status:"committed",version:state.version+1};
    }
    return route.fulfill({json:state});
  });
  await page.goto("/map");await page.getByRole("link",{name:"Sign in as operator"}).click();
  await page.getByRole("button",{name:"Import KML points"}).click();
});
async function upload(page: import("@playwright/test").Page) {
  const dialog=page.getByRole("dialog");
  await dialog.getByLabel("KML or compressed KML file").setInputFiles({name:"synthetic-points.kml",mimeType:"application/xml",buffer:Buffer.from('<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Point><coordinates>100,20</coordinates></Point></Placemark></kml>')});
  await dialog.getByRole("button",{name:"Upload and preview"}).click();
  await expect(dialog.getByRole("img",{name:"Geographic preview (WGS84)"})).toBeVisible();
}
test("completes four steps, resumes after reload and commits linked Evidence",async({page})=>{
  await upload(page);
  const dialog=page.getByRole("dialog");
  await dialog.getByRole("button",{name:"Next",exact:true}).click();
  await dialog.getByLabel("Linear Asset").selectOption(assetId);
  await dialog.getByRole("button",{name:"Next",exact:true}).click();
  await expect(dialog.getByLabel("Import target")).toBeVisible();
  await page.reload();
  await expect(dialog.getByLabel("Import target")).toBeVisible();
  await dialog.getByLabel("Import target").selectOption("evidence");
  await expect(dialog.getByRole("button",{name:"Save mapping"})).toBeDisabled();
  await dialog.getByRole("combobox",{name:"Barrier",exact:true}).selectOption(barrierId);
  await dialog.getByRole("button",{name:"Save mapping"}).click();
  await expect(dialog.locator(".mono").filter({hasText:"500.0"})).toBeVisible();
  await dialog.getByRole("button",{name:"Commit import"}).click();
  await expect(dialog.getByRole("status")).toContainText("Import committed");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button",{name:"Import KML points"})).toBeFocused();
});
for(const theme of ["light","dark"] as const) for(const width of [390,1280]) {
  test(`wizard passes axe in ${theme} at ${width}`,async({page})=>{
    await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:"reduce"});
    if(theme==="dark") {await page.keyboard.press("Escape");await page.getByRole("button",{name:"Night shift"}).click();await page.getByRole("button",{name:"Import KML points"}).click();}
    const audit=async()=>{
      const result=await new AxeBuilder({page}).include('[role="dialog"]').withTags(["wcag2a","wcag2aa","wcag21aa","wcag22aa"]).analyze();
      expect(result.violations).toEqual([]);
    };
    await audit();await upload(page);await audit();
    const dialog=page.getByRole("dialog");
    await dialog.getByRole("button",{name:"Next",exact:true}).click();await audit();
    await dialog.getByLabel("Linear Asset").selectOption(assetId);
    await dialog.getByRole("button",{name:"Next",exact:true}).click();
    await expect(dialog.getByLabel("Import target")).toBeVisible();await audit();
    if(theme==="light"&&width===1280) await page.screenshot({path:"e2e/evidence/import-wizard-light.png"});
  });
}
test("Thai wizard reflows at 320 CSS pixels",async({page})=>{
  await page.keyboard.press("Escape");
  await page.setViewportSize({width:320,height:900});
  await page.getByRole("button",{name:"ภาษาไทย"}).click();
  await page.getByRole("button",{name:"นำเข้าจุด KML"}).click();
  const dialog=page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({name:"synthetic.kml",mimeType:"application/xml",buffer:Buffer.from("synthetic fixture")});
  await dialog.getByRole("button",{name:"อัปโหลดและดูตัวอย่าง"}).click();
  await expect(dialog.getByRole("img",{name:"แผนที่ตัวอย่าง (WGS84)"})).toBeVisible();
  expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  const result=await new AxeBuilder({page}).include('[role="dialog"]').withTags(["wcag2a","wcag2aa","wcag21aa","wcag22aa"]).analyze();
  expect(result.violations).toEqual([]);
});
