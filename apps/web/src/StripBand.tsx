import { HealthBadge } from "@fieldloop/ui";
import type { StripBandData } from "./strip-band-data";
import "./strip-band.css";

export interface StripBandProps {
  /** Supply only a snapshot authorized by the BFF for the current user and Asset. */
  readonly data: StripBandData;
  readonly language?: "en" | "th";
}

const COPY = {
  en: { title: "Strip", axis: "Chainage", snapshot: "Read-only seed snapshot", segments: "Segments",
    barriers: "Barriers", facilities: "Facilities", unlocated: "No confirmed Chainage — Asset-scoped Barriers are not positioned.",
    inspections: "Inspection features", noInspections: "No located inspection features in the seed.",
    threats: "Threat Categories", noThreats: "No located Threat Categories in the seed.",
    healthy: "Healthy", degraded: "Degraded", failed: "Failed", unverified: "Unverified" },
  th: { title: "แถบระยะทาง", axis: "ระยะทางตามแนวเส้น", snapshot: "ข้อมูล seed แบบอ่านอย่างเดียว", segments: "ช่วงของแนวเส้น",
    barriers: "มาตรการป้องกัน", facilities: "สถานี", unlocated: "ไม่มีระยะทางที่ยืนยัน — มาตรการระดับสินทรัพย์ไม่ถูกวางตำแหน่ง",
    inspections: "รายการตรวจสอบ", noInspections: "ไม่มีรายการตรวจสอบที่ระบุตำแหน่งใน seed",
    threats: "หมวดภัยคุกคาม", noThreats: "ไม่มีหมวดภัยคุกคามที่ระบุตำแหน่งใน seed",
    healthy: "ปกติ", degraded: "เสื่อมสภาพ", failed: "ล้มเหลว", unverified: "ยังไม่ยืนยัน" },
} as const;


/** Presentational, read-only component. No seed import, auth decision, or interactive map synchronization. */
export function StripBand({ data, language = "en" }: StripBandProps) {
  const text = COPY[language];
  return <section className="strip-band" lang={language} aria-label={text.title}>
    <header><h2>{text.title} · <span className="strip-mono">{data.assetCode}</span></h2>
      <span className="strip-simulation" lang="en">SIMULATION · SYNTHETIC</span>
      <p>{text.snapshot} · <span className="strip-mono">{data.classification}</span></p>
    </header>
    <div className="strip-axis"><span>{text.axis} (m)</span><span className="strip-mono">0 — {data.lengthM}</span></div>
    <h3>{text.segments}</h3>
    <div className="strip-segments" aria-hidden="true">{data.segments.map(segment => <span key={segment.id}
      style={{ left: `${segment.chainageFromM / data.lengthM * 100}%`,
        width: `${(segment.chainageToM - segment.chainageFromM) / data.lengthM * 100}%` }} />)}</div>
    <ol className="strip-segment-list">{data.segments.map(segment => <li key={segment.id}>
      <span className="strip-mono" lang="en">{segment.name}</span><span className="strip-mono">{segment.chainageFromM} — {segment.chainageToM} m</span>
    </li>)}</ol>
    <h3>{text.facilities}</h3><ul className="strip-facilities">{data.facilities.map(facility => <li key={facility.id}>
      <span className="strip-mono" lang="en">{facility.name}</span> · <span className="strip-mono">{facility.chainageM} m</span>
    </li>)}</ul>
    <h3>{text.barriers}</h3><p>{text.unlocated}</p>
    <ul className="strip-barriers" role="list">{data.barriers.map(barrier => <li key={barrier.id}>
      <span className="strip-mono" lang="en">{barrier.name}</span> <HealthBadge health={barrier.health} label={text[barrier.health]} />
    </li>)}</ul>
    <h3>{text.inspections}</h3><p>{text.noInspections}</p>
    <h3>{text.threats}</h3><p>{text.noThreats}</p>
  </section>;
}
