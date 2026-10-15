import { HealthBadge } from "@fieldloop/ui";
import type { StripBandData } from "./strip-band-data";
import "./strip-band.css";

export interface StripBandProps {
  /** Supply only a snapshot authorized by the BFF for the current user and Asset. */
  readonly data: StripBandData;
  readonly language?: "en" | "th";
}

const COPY = {
  en: {
    title: "Strip", axis: "Chainage (m)", segments: "Segments", barriers: "Barriers", facilities: "Facilities",
    unlocated: "No confirmed Chainage — Asset-scoped Barriers are not positioned.",
    inspections: "No located inspection features", threats: "No located Threat Categories",
    healthy: "Healthy", degraded: "Degraded", failed: "Failed", unverified: "Unverified",
  },
  th: {
    title: "แถบระยะทาง", axis: "ระยะทางตามแนวเส้น (ม.)", segments: "ช่วงของแนวเส้น", barriers: "มาตรการป้องกัน", facilities: "สถานี",
    unlocated: "ไม่มีระยะทางที่ยืนยัน — มาตรการระดับสินทรัพย์ยังไม่มีตำแหน่ง",
    inspections: "ไม่มีรายการตรวจสอบที่ระบุตำแหน่ง", threats: "ไม่มีหมวดภัยคุกคามที่ระบุตำแหน่ง",
    healthy: "ปกติ", degraded: "เสื่อมสภาพ", failed: "ล้มเหลว", unverified: "ยังไม่ยืนยัน",
  },
} as const;

/** Presentational, read-only component. No seed import, auth decision, or interactive map synchronization. */
export function StripBand({ data, language = "en" }: StripBandProps) {
  const text = COPY[language];
  const segments = [...data.segments].sort((left, right) => left.chainageFromM - right.chainageFromM || left.id.localeCompare(right.id));
  const facilities = [...data.facilities].sort((left, right) => left.chainageM - right.chainageM || left.id.localeCompare(right.id));
  const barriers = [...data.barriers].sort((left, right) =>
    (left.chainageM ?? Number.POSITIVE_INFINITY) - (right.chainageM ?? Number.POSITIVE_INFINITY) || left.name.localeCompare(right.name),
  );
  const hasUnlocatedBarriers = barriers.some((barrier) => barrier.chainageM === null);
  const formatter = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

  return <section className="strip-band" lang={language} aria-label={text.title}>
    <header className="strip-band-header">
      <h2>{text.title} · <span className="strip-mono">{data.assetCode}</span></h2>
      <span className="strip-simulation" lang="en">SIMULATION · SYNTHETIC</span>
      <span className="strip-classification strip-mono">{data.classification}</span>
    </header>
    <div className="strip-axis"><span>{text.axis}</span><span className="strip-mono">0 — {formatter.format(data.lengthM)}</span></div>
    <div className="strip-lane">
      <h3>{text.segments}</h3>
      <div className="strip-segments" role="list" aria-label={text.segments}>
        {segments.map((segment) => <span key={segment.id} role="listitem"
          aria-label={`${segment.name}, ${formatter.format(segment.chainageFromM)} to ${formatter.format(segment.chainageToM)} m`}
          title={`${segment.name} · ${formatter.format(segment.chainageFromM)} — ${formatter.format(segment.chainageToM)} m`}
          style={{ left: `${segment.chainageFromM / data.lengthM * 100}%`,
            width: `${(segment.chainageToM - segment.chainageFromM) / data.lengthM * 100}%` }}>
          <span className="strip-segment-name strip-mono">{shortSegmentName(segment.name, data.assetCode)}</span>
        </span>)}
      </div>
    </div>
    <div className="strip-lane strip-facility-lane">
      <h3>{text.facilities}</h3>
      <ul className="strip-facilities" aria-label={text.facilities}>
        {facilities.map((facility) => <li key={facility.id}
          aria-label={`${facility.name}, ${formatter.format(facility.chainageM)} m`}
          style={{ left: `${facility.chainageM / data.lengthM * 100}%` }}>
          <span className="strip-facility-name strip-mono">{shortFacilityName(facility.name, data.assetCode)}</span>
          <span className="strip-mono">{formatter.format(facility.chainageM)} m</span>
        </li>)}
      </ul>
    </div>
    <div className="strip-lane strip-barrier-lane">
      <h3>{text.barriers}</h3>
      <div className="strip-barrier-content">
        {hasUnlocatedBarriers && <p className="strip-unlocated">{text.unlocated}</p>}
        <ul className="strip-barriers" aria-label={text.barriers} tabIndex={0}>
          {barriers.map((barrier) => <li key={barrier.id}>
            <span className="strip-barrier-name strip-mono" lang="en">{barrier.name}</span>
            {barrier.chainageM !== null && <span className="strip-mono">{formatter.format(barrier.chainageM)} m</span>}
            <HealthBadge health={barrier.health} label={text[barrier.health]} />
          </li>)}
        </ul>
      </div>
    </div>
    <p className="strip-band-empty">{data.inspections.length === 0 ? text.inspections : `${text.inspections}: ${data.inspections.length}`} · {data.threatCategories.length === 0 ? text.threats : `${text.threats}: ${data.threatCategories.length}`}</p>
  </section>;
}

function shortSegmentName(name: string, assetCode: string): string {
  return name.replace(`${assetCode} `, "").replace(/^Segment\s+/i, "");
}

function shortFacilityName(name: string, assetCode: string): string {
  return name.replace(`${assetCode} `, "").replace(/^Block Valve Station\s+/i, "BVS ");
}
