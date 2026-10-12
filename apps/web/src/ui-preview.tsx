import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActionLevelBadge, Button, Card, EmptyState, HealthBadge, Input, MapMarker, Modal, MultiSelect, Navigation, Select, SimulationBanner, Skeleton, Tabs, Textarea, Toast, ToastProvider, TopBar } from "@fieldloop/ui";
import type { BarrierHealth, ToastProps } from "@fieldloop/ui";
import "@fontsource/ibm-plex-sans-thai/400.css";
import "@fontsource/ibm-plex-sans-thai/500.css";
import "@fontsource/ibm-plex-sans-thai/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fieldloop/ui/styles.css";
import "./ui-preview.css";

const shortOptions = [{ value: "evidence", label: "Evidence" }, { value: "barrier", label: "Barrier" }, { value: "archived", label: "Archived", disabled: true }];
const longOptions = ["Inspection", "Patrol", "Maintenance", "Pressure", "Flow", "Rain", "Water level", "Tide", "Pump", "Gate", "Sensor", "Integrity"].map(label => ({ value: label, label }));
const healths: BarrierHealth[] = ["healthy", "degraded", "failed", "unverified"];

function Preview() {
  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
  const [language, setLanguage] = useState<"en" | "th">("en");
  const [selected, setSelected] = useState("evidence");
  const [source, setSource] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [tab, setTab] = useState("evidence");
  const [open, setOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [notification, setNotification] = useState<ToastProps["variant"]>("info");
  const [toastOpen, setToastOpen] = useState(false);
  const [marker, setMarker] = useState("");
  const [previewAction, setPreviewAction] = useState("");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset["theme"];
    else document.documentElement.dataset["theme"] = theme;
    document.documentElement.lang = language;
  }, [theme, language]);
  const th = language === "th";
  const navItems = [{ href: "#controls", label: "Controls", icon: "C", active: true }, { href: "#feedback", label: "Feedback", icon: "F" }, { href: "#domain", label: "Domain", icon: "D" }];
  return <ToastProvider label={th ? "การแจ้งเตือน" : "Notification"}>
    <a className="preview-skip" href="#preview-main">{th ? "ข้ามไปยังเนื้อหา" : "Skip to components"}</a>
    <TopBar homeHref="/ui-preview.html">
      <Button variant="secondary" onClick={() => setLanguage(th ? "en" : "th")} lang={th ? "en" : "th"}>{th ? "English" : "ภาษาไทย"}</Button>
      <Button variant="secondary" aria-pressed={theme === "dark"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>Night shift</Button>
      <Button variant="secondary" aria-pressed={theme === "system"} onClick={() => setTheme("system")}>System theme</Button>
    </TopBar>
    <SimulationBanner scenario="Component fixtures" speed="1×" />
    <div className="preview-layout">
      <aside className="preview-rail"><Navigation label="Component groups" items={navItems} /></aside>
      <main id="preview-main" tabIndex={-1} className="preview-main" lang="en">
        <header className="preview-heading" lang={language}><p className="preview-eyebrow">SHARED COMPONENTS · <span className="fl-mono">FL-79</span></p><h1>{th ? "ชุดองค์ประกอบหน้าจอ FieldLoop" : "FieldLoop component library"}</h1><p>{th ? "ตัวอย่างข้อมูลสังเคราะห์สำหรับตรวจรูปแบบ การใช้แป้นพิมพ์ และสถานะขององค์ประกอบ" : "SYNTHETIC fixtures for inspecting tokens, keyboard behaviour and component states."}</p></header>
        <section id="controls" className="preview-section" aria-labelledby="controls-title"><h2 id="controls-title" lang={language}>{th ? "ปุ่มและแบบฟอร์ม" : "Controls"}</h2>
          <Card><h3>Buttons</h3><div className="preview-row">{(["primary", "secondary", "ghost", "danger"] as const).map(variant => <Button key={variant} variant={variant} onClick={() => setPreviewAction(`${variant} button activated`)}>{variant === "primary" ? "Create Draft" : variant === "danger" ? "Stop preview" : variant === "secondary" ? "View Evidence" : "Inspect sources"}</Button>)}</div>
          <div className="preview-row"><Button size="sm">Compact button</Button><Button size="lg">Field button</Button><Button disabled>Unavailable</Button><Button loading>Create Draft</Button></div>
          <div className="preview-row">{(["secondary", "ghost", "danger"] as const).map(variant => <Button key={variant} variant={variant} disabled>Unavailable {variant}</Button>)}</div><p role="status" className="fl-helper">{previewAction}</p></Card>
          <Card variant="divided"><form className="preview-fields" aria-label="Component form">
            <Input lang={language} label={th ? "ชื่อหลักฐาน" : "Evidence title"} helper={th ? "ระบุแหล่งที่มาของหลักฐาน" : "Describe the Evidence source."} defaultValue={th ? "รายงานการตรวจสังเคราะห์" : "Synthetic inspection"} />
            <Input label="Chainage" type="number" defaultValue={0} helper="SYNTHETIC · metres" />
            <Input lang={language} label={th ? "เหตุผลที่จำเป็น" : "Required reason"} error={th ? "กรุณาระบุเหตุผล" : "Enter a reason."} required />
            <Input label="Disabled input" disabled defaultValue="Unavailable" />
            <Input label="Field input" fieldSize="lg" helper="Field / crisis touch target" />
            <Textarea label={th ? "หมายเหตุ" : "Notes"} helper={th ? "รองรับข้อความภาษาไทยหลายบรรทัด" : "Supports multiline Thai text."} defaultValue="หลักฐานสังเคราะห์สำหรับการตรวจสอบ" lang="th" />
            <Select lang="en" name="category" label="Evidence type" options={shortOptions} value={selected} onValueChange={setSelected} />
            <Select lang="en" name="disabled-category" label="Disabled select" options={shortOptions} value="evidence" onValueChange={() => undefined} disabled />
            <Select lang="en" label="Required category" options={shortOptions} value="" onValueChange={() => undefined} error="Choose a category." />
            <Select lang="en" name="source" label="Source" options={longOptions} value={source} onValueChange={setSource} helper="Searchable because there are more than ten options." />
            <MultiSelect lang="en" name="sources" label="Sources" options={longOptions} value={sources} onValueChange={setSources} />
            <Select lang="en" name="disabled-source" label="Disabled searchable select" options={longOptions} value="Rain" onValueChange={() => undefined} disabled />
            <MultiSelect lang="en" name="disabled-sources" label="Disabled multiple select" options={longOptions} value={["Rain", "Pump"]} onValueChange={() => undefined} disabled />
          </form></Card>
          <Card variant="subtle"><Tabs label="Evidence details" value={tab} onValueChange={setTab} items={[{ value: "evidence", label: "Evidence", content: <p>SYNTHETIC · inspection report</p> }, { value: "history", label: "History", content: <p>No history in this fixture.</p> }, { value: "export", label: "Export", disabled: true, content: null }]} /></Card>
        </section>
        <section id="feedback" className="preview-section" aria-labelledby="feedback-title"><h2 id="feedback-title" lang={language}>{th ? "ข้อความและสถานะ" : "Feedback"}</h2>
          <Card><div className="preview-row">
            <Modal lang="en" title="Inspect Evidence" description="This fixture has no stored data." open={open} onOpenChange={setOpen} trigger={<Button variant="secondary">Open modal</Button>}><Input label="Evidence note" /><Select lang="en" label="Modal category" options={shortOptions} value={selected} onValueChange={setSelected} /><p>SYNTHETIC · modal keyboard example</p></Modal>
            <Modal lang="en" title="Consequential action layout" description="Preview only. No Action Request is created." approval open={approvalOpen} onOpenChange={setApprovalOpen} trigger={<Button variant="secondary">Open approval layout</Button>} footer={<Button onClick={() => { setPreviewAction("Preview action activated"); setApprovalOpen(false); }}>Activate preview action</Button>}>
              <p>This does: demonstrate a confirmation layout.</p><p>This does not: send a warning or operate equipment.</p><pre className="preview-payload fl-mono">{"SYNTHETIC · fixture: layout-only"}</pre><Input label="Action reason" />
            </Modal>
          </div></Card>
          <Card variant="divided"><h3>Notifications</h3><div className="preview-row">{(["info", "success", "warning", "error"] as const).map(variant => <Button key={variant} variant="secondary" onClick={() => { setNotification(variant); setToastOpen(true); }}>Show {variant}</Button>)}</div><p className="fl-helper">Info/success dismiss after six seconds; warning/error require dismissal.</p></Card>
          <Card variant="subtle"><h3>Loading blocks</h3><div className="preview-loading" role="status" aria-label="Loading preview"><Skeleton variant="row" /><Skeleton variant="text" /><Skeleton variant="badge" /></div></Card>
          <div lang={language}><EmptyState title={th ? "ยังไม่มีหลักฐาน" : "No Evidence yet"} description={th ? "เพิ่มรายงานเพื่อเริ่มตรวจสอบ" : "Add a report to begin inspection."} action={<Button variant="secondary" onClick={() => setPreviewAction("Evidence upload preview")}>{th ? "เพิ่มหลักฐาน" : "Upload Evidence"}</Button>} /></div>
        </section>
        <section id="domain" className="preview-section" aria-labelledby="domain-title"><h2 id="domain-title" lang={language}>{th ? "สถานะและการนำทาง" : "Domain and navigation"}</h2>
          <Card><h3>Barrier Health</h3><div className="preview-row">{healths.map(health => <HealthBadge key={health} health={health} />)}</div><h3>Action Levels</h3><div className="preview-row">{(["l0", "l1", "l2"] as const).map(level => <ActionLevelBadge key={level} level={level} />)}</div></Card>
          <Card variant="divided"><h3>Map markers</h3><div className="preview-row">{(["degraded", "failed", "unverified"] as const).map(health => <MapMarker key={health} health={health} label={`${health} Barrier marker`} onClick={() => setMarker(health)} />)}<MapMarker health="failed" label="Disabled Barrier marker" disabled /></div><p role="status" className="fl-helper">{marker ? `Selected ${marker} Barrier fixture` : "Keyboard-operable marker examples. Production maps also need a list equivalent."}</p></Card>
          <Card variant="subtle"><h3>Navigation drawer</h3><Navigation variant="drawer" label="Drawer preview" items={[...navItems, { href: "#unavailable", label: "Offline", icon: "O", disabled: true, disabledReason: "Requires a connection" }]} /><h3>Bottom navigation</h3><Navigation variant="bottom" label="Bottom preview" items={navItems} /></Card>
        </section>
        <footer className="preview-footer">Powered by Kaotor Technology</footer>
      </main>
    </div>
    <Toast lang="en" key={notification} variant={notification} open={toastOpen} onOpenChange={setToastOpen} message={`${notification}: SYNTHETIC preview notification`} action={{ label: "Inspect fixture", altText: "Inspect this synthetic fixture", onClick: () => setPreviewAction("Notification fixture inspected") }} />
  </ToastProvider>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing preview root");
createRoot(root).render(<StrictMode><Preview /></StrictMode>);
