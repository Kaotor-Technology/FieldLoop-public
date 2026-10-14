import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { components } from "@fieldloop/contracts";
import { Modal, Button } from "@fieldloop/ui";
import { api, SessionError } from "./api-client";
import { useCurrentSession } from "./SessionGate";
import { usePreferences } from "./preferences";
import { monoNumericText } from "./mono-numeric-text";

type Mapping = components["schemas"]["ImportMapping"];
type Preview = components["schemas"]["ImportPreview"];
const labels = {
  en: { title:"Import KML points",description:"Upload synthetic or simulated points, review their locations and choose an import target.",steps:["Upload","Preview on map","Map attributes","Choose target"],close:"Close",next:"Next",back:"Back",upload:"Upload and preview",asset:"Linear Asset",tolerance:"Snap tolerance (metres)",name:"Name field",descriptionField:"Description field",category:"Category field",target:"Import target",barrier:"Barrier",commit:"Commit import",done:"Import committed. Barrier Health has not changed.",error:"Import could not be completed. Check the file, permissions and current version, then retry.",loading:"Loading import…",none:"Choose a value",point:"Point",chainage:"Chainage (metres)",distance:"Distance (metres)",flags:"Validation flags",unconfigured:"Organisation area is not configured; boundary validation is unavailable.",warnings:"Review warning flags before committing. Points outside tolerance receive no Chainage.",simulation:"SIMULATION",empty:"No eligible Assets. Check your clearance and the synthetic route seed.",map:"Geographic preview (WGS84)",save:"Save mapping",notMapped:"Not mapped",duplicate:"Duplicate points must be removed from the source file before importing.",file:"KML or compressed KML file" },
  th: { title:"นำเข้าจุด KML",description:"อัปโหลดจุดสังเคราะห์หรือจำลอง ตรวจสอบตำแหน่ง แล้วเลือกเป้าหมายการนำเข้า",steps:["อัปโหลด","ดูตัวอย่างบนแผนที่","จับคู่ข้อมูล","เลือกเป้าหมาย"],close:"ปิด",next:"ถัดไป",back:"ย้อนกลับ",upload:"อัปโหลดและดูตัวอย่าง",asset:"Linear Asset",tolerance:"ระยะ snap (เมตร)",name:"ฟิลด์ชื่อ",descriptionField:"ฟิลด์คำอธิบาย",category:"ฟิลด์หมวดหมู่",target:"เป้าหมายการนำเข้า",barrier:"Barrier",commit:"ยืนยันนำเข้า",done:"นำเข้าสำเร็จ โดยไม่ได้เปลี่ยน Barrier Health",error:"นำเข้าไม่สำเร็จ โปรดตรวจไฟล์ สิทธิ์ และเวอร์ชันปัจจุบันก่อนลองใหม่",loading:"กำลังโหลด…",none:"เลือกค่า",point:"จุด",chainage:"Chainage (เมตร)",distance:"ระยะห่าง (เมตร)",flags:"ผลตรวจสอบ",unconfigured:"ยังไม่ได้กำหนดพื้นที่ Organisation จึงตรวจขอบเขตไม่ได้",warnings:"ตรวจคำเตือนก่อนนำเข้า จุดนอกระยะ snap จะไม่มี Chainage",simulation:"SIMULATION",empty:"ไม่มี Asset ที่ใช้ได้ โปรดตรวจสิทธิ์และข้อมูลเส้นทางสังเคราะห์",map:"แผนที่ตัวอย่าง (WGS84)",save:"บันทึกการจับคู่",notMapped:"ยังไม่จับคู่",duplicate:"โปรดลบจุดซ้ำจากไฟล์ต้นทางแล้วอัปโหลดใหม่",file:"ไฟล์ KML หรือ KML แบบบีบอัด" },
};
const blank: Mapping = { assetId:"",toleranceMetres:50,nameField:"name",descriptionField:"description",categoryField:"folder",target:"facility",barrierId:null };
export function ImportWizard() {
  const user = useCurrentSession(), client = useQueryClient();
  const language = usePreferences((state) => state.language), text = labels[language];
  const search = useSearch({ from:"/map" }), navigate = useNavigate({ from:"/map" });
  const importId = typeof search["import"] === "string" ? search["import"] : undefined;
  const step = Math.max(1,Math.min(4,Number(search["step"]) || 1));
  const [open,setOpen] = useState(Boolean(importId));
  const [file,setFile] = useState<File | null>(null);
  const [draft,setDraft] = useState<Mapping | null>(null);
  const [requestKey,setRequestKey] = useState(() => crypto.randomUUID());
  const preview = useQuery({queryKey:["import",importId],enabled:open && Boolean(importId),retry:false,queryFn:async ({signal}) => {
    const {data,response} = await api.GET("/v1/imports/{importId}/preview",{params:{path:{importId:importId ?? ""}},signal});
    if (!response.ok || !data) throw new SessionError(response.status); return data;
  }});
  const options = useQuery({queryKey:["import-options"],enabled:open,retry:false,queryFn:async ({signal}) => {
    const {data,response} = await api.GET("/v1/imports/options",{signal});
    if (!response.ok || !data) throw new SessionError(response.status); return data;
  }});
  const fields = Array.from(new Set(preview.data?.points.flatMap(point => Object.keys(point.attributes)) ?? []));
  const mapping = draft ?? preview.data?.mapping ?? {...blank,nameField:fields.includes("name") ? "name":"",descriptionField:fields.includes("description") ? "description":""};
  const changeStep = (next: number,id = importId) => void navigate({search:previous => ({...previous,import:id,step:next}),replace:true});
  const saveResult = (data: Preview) => { client.setQueryData(["import",data.id],data); setDraft(null); };
  const upload = useMutation({mutationFn:async () => {
    if (!file || file.size > 2 * 1024 * 1024 || !/\.(kml|kmz)$/i.test(file.name)) throw new Error("Invalid file");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
    const {data,response} = await api.POST("/v1/imports",{params:{header:{"X-CSRF-Token":user.data?.csrfToken ?? "","Idempotency-Key":requestKey}},body:{format:/\.kmz$/i.test(file.name)?"kmz":"kml",contentBase64:btoa(binary)}});
    if (!response.ok || !data) throw new SessionError(response.status); return data;
  },onSuccess:data => {saveResult(data);changeStep(2,data.id);}});
  const save = useMutation({mutationFn:async (targetStep: number) => {
    if (!preview.data) throw new Error("No preview");
    const {data,response} = await api.PUT("/v1/imports/{importId}/mapping",{params:{path:{importId:preview.data.id},header:{"X-CSRF-Token":user.data?.csrfToken ?? ""}},body:{version:preview.data.version,mapping}});
    if (!response.ok || !data) throw new SessionError(response.status); return {data,targetStep};
  },onSuccess:({data,targetStep}) => {saveResult(data);changeStep(targetStep);}});
  const commit = useMutation({mutationFn:async () => {
    if (!preview.data) throw new Error("No preview");
    const {data,response} = await api.POST("/v1/imports/{importId}:commit",{params:{path:{importId:preview.data.id},header:{"X-CSRF-Token":user.data?.csrfToken ?? "","Idempotency-Key":`${preview.data.id}:commit`}},body:{version:preview.data.version}});
    if (!response.ok || !data) throw new SessionError(response.status); return data;
  },onSuccess:data => {saveResult(data);void client.invalidateQueries({queryKey:["map-layer"]});}});
  const pending = upload.isPending || save.isPending || commit.isPending;
  const failed = upload.isError || save.isError || commit.isError || preview.isError || options.isError;
  const set = (update: Partial<Mapping>) => setDraft({...mapping,...update});
  const committed = preview.data?.status === "committed";
  const duplicates = preview.data?.points.some(point => point.flags.includes("duplicate"));
  const startNew = () => {
    setFile(null);setDraft(null);setRequestKey(crypto.randomUUID());upload.reset();save.reset();commit.reset();
    void navigate({search:previous => {const next={...previous};delete next["import"];delete next["step"];return next;},replace:true});
  };
  if (!user.data?.roles.some(role => role === "fieldloop.operator" || role === "fieldloop.manager")) return null;
  return <Modal open={open} onOpenChange={setOpen} lang={language} title={text.title} description={text.description} closeLabel={text.close}
    trigger={<Button variant="secondary">{text.title}</Button>}>
    <div className="import-wizard" aria-busy={pending}>
      <p className="simulation-label">{text.simulation}</p>
      <ol className="import-steps">{text.steps.map((label,index) => <li key={label} aria-current={step === index+1 ? "step":undefined}><span className="mono">{index+1}</span> {label}</li>)}</ol>
      {failed ? <p role="alert" id="import-error">▲ {text.error}</p>:null}
      {committed ? <><p role="status">{text.done}</p><Button onClick={startNew}>{language === "th" ? "นำเข้าไฟล์ใหม่" : "Import another file"}</Button></>:<>
        {step === 1 ? <label>{text.file}<input type="file" accept=".kml,.kmz" disabled={pending} aria-describedby={failed?"import-error":undefined} onChange={event => {setFile(event.target.files?.[0] ?? null);setRequestKey(crypto.randomUUID());upload.reset();}} /></label>:null}
        {importId && preview.isPending ? <p role="status">{text.loading}</p>:null}
        {preview.data && step >= 2 ? <>
          <ImportPreviewMap points={preview.data.points} label={text.map} />
          <div className="import-point-list" tabIndex={0} role="region" aria-label={text.map}><table><thead><tr><th>{text.point}</th><th>{language === "th" ? "พิกัด" : "Coordinates"}</th><th>{text.distance}</th><th>{text.chainage}</th><th>{text.flags}</th></tr></thead><tbody>
            {preview.data.points.map((point,index) => <tr key={point.id}><th scope="row">{point.attributes["name"] ? monoNumericText(point.attributes["name"]) : <span className="mono">{index+1}</span>}</th><td className="mono">{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</td><td className="mono">{point.distanceMetres?.toFixed(1) ?? "—"}</td><td className="mono">{point.chainageMetres?.toFixed(1) ?? "—"}</td><td>{point.flags.map(flag => <span className="import-flag" key={flag}>▲ {flagLabel(flag,language)}</span>)}</td></tr>)}
          </tbody></table></div>
        </>:null}
        {step === 3 ? <div className="import-fields">
          <label>{text.asset}<select value={mapping.assetId} onChange={event => set({assetId:event.target.value,barrierId:null})}><option value="">{text.none}</option>{options.data?.assets.map(asset => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</select></label>
          {!options.isPending && !options.data?.assets.length ? <p role="status">{text.empty}</p>:null}
          <label>{text.tolerance}<input className="mono" type="number" min={0} max={1000} value={mapping.toleranceMetres} onChange={event => set({toleranceMetres:Number(event.target.value)})} /></label>
          {([['nameField',text.name],['descriptionField',text.descriptionField],['categoryField',text.category]] as const).map(([key,label]) => <label key={key}>{label}<select value={mapping[key]} onChange={event => set({[key]:event.target.value})}><option value="">{text.none}</option>{fields.map(field => <option key={field} value={field}>{field}</option>)}</select></label>)}
        </div>:null}
        {step === 4 ? <div className="import-fields">
          <p>{text.warnings}</p>
          {preview.data?.points.some(point => point.flags.includes("organisation_area_unconfigured")) ? <p role="status">▲ {text.unconfigured}</p>:null}
          <label>{text.target}<select value={mapping.target} onChange={event => set({target:event.target.value as Mapping["target"],barrierId:null})}><option value="facility">Facility</option><option value="evidence">Evidence</option></select></label>
          {mapping.target === "evidence" ? <label>{text.barrier}<select value={mapping.barrierId ?? ""} onChange={event => set({barrierId:event.target.value || null})}><option value="">{text.none}</option>{options.data?.barriers.filter(barrier => barrier.assetId === mapping.assetId).map(barrier => <option key={barrier.id} value={barrier.id}>{barrier.name}</option>)}</select></label>:null}
          {duplicates ? <p role="alert">▲ {text.duplicate}</p>:null}
          <p className="mono">{preview.data?.classification} · {preview.data?.fileHash}</p>
        </div>:null}
        <div className="import-actions">
          {step > 1 ? <Button variant="secondary" disabled={pending} onClick={() => changeStep(step-1)}>{text.back}</Button>:null}
          {step === 1 ? <Button disabled={!file || pending} onClick={() => upload.mutate()}>{text.upload}</Button>:null}
          {step === 2 ? <Button disabled={!preview.data || pending} onClick={() => changeStep(3)}>{text.next}</Button>:null}
          {step === 3 ? <Button disabled={!mapping.assetId || pending} onClick={() => save.mutate(4)}>{text.next}</Button>:null}
          {step === 4 && draft ? <Button disabled={pending || (mapping.target === "evidence" && !mapping.barrierId)} onClick={() => save.mutate(4)}>{text.save}</Button>:null}
          {step === 4 && !draft ? <Button disabled={pending || duplicates || preview.data?.status !== "mapped"} onClick={() => commit.mutate()}>{text.commit}</Button>:null}
        </div>
      </>}
    </div>
  </Modal>;
}

function flagLabel(flag: string, language: "en" | "th"): string {
  const thai:Record<string,string>={not_mapped:"ยังไม่จับคู่",outside_snap_tolerance:"นอกระยะ snap",outside_organisation_area:"นอกพื้นที่ Organisation",organisation_area_unconfigured:"ยังไม่กำหนดพื้นที่ Organisation",duplicate:"จุดซ้ำ"};
  return language === "th" ? thai[flag] ?? flag : flag.replaceAll("_"," ");
}

function ImportPreviewMap({points,label}: {points:Preview["points"];label:string}) {
  // Local geographic preview keeps uploaded coordinates out of external services.
  const west = Math.min(...points.map(point => point.longitude)), east = Math.max(...points.map(point => point.longitude));
  const south = Math.min(...points.map(point => point.latitude)), north = Math.max(...points.map(point => point.latitude));
  const span = Math.max(east-west,north-south,0.00001);
  return <figure className="import-map"><figcaption>{label}</figcaption><svg viewBox="0 0 100 100" role="img" aria-label={label}>
    <path className="import-grid" d="M10 10H90V90H10ZM10 30H90M10 50H90M10 70H90M30 10V90M50 10V90M70 10V90" />
    {points.map(point => <circle key={point.id} cx={50+80*(point.longitude-(east+west)/2)/span} cy={50-80*(point.latitude-(north+south)/2)/span} r="1" className={point.flags.length ? "import-marker-warning":"import-marker"}><title>{point.attributes["name"]} · {point.latitude}, {point.longitude}</title></circle>)}
  </svg><p className="mono">{south.toFixed(5)}–{north.toFixed(5)} N · {west.toFixed(5)}–{east.toFixed(5)} E</p></figure>;
}
