import { useId } from "react";
import type { ButtonHTMLAttributes } from "react";

export type BarrierHealth = "healthy" | "degraded" | "failed" | "unverified";
export type ActionLevel = "l0" | "l1" | "l2";
const healthShapes: Record<BarrierHealth, string> = { healthy: "●", degraded: "▲", failed: "✖", unverified: "⬚" };
const healthLabels: Record<BarrierHealth, string> = { healthy: "Healthy", degraded: "Degraded", failed: "Failed", unverified: "Unverified" };

export interface HealthBadgeProps { health: BarrierHealth; label?: string }
export function HealthBadge({ health, label = healthLabels[health] }: HealthBadgeProps) {
  return <span className="fl-health-badge" data-health={health}><span aria-hidden="true">{healthShapes[health]}</span>{label}</span>;
}
export interface ActionLevelBadgeProps { level: ActionLevel; label?: string }
export function ActionLevelBadge({ level, label = "Action Level" }: ActionLevelBadgeProps) {
  return <span className="fl-action-badge fl-mono" aria-label={`${label} ${level.toUpperCase()}`}>{level.toUpperCase()}</span>;
}
export interface MapMarkerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> { health: Exclude<BarrierHealth, "healthy">; label: string }
export function MapMarker({ health, label, className = "", type = "button", ...props }: MapMarkerProps) {
  const hatchId = useId();
  return <button {...props} type={type} className={`fl-map-marker ${className}`} data-health={health} aria-label={label}><span aria-hidden="true">
    <svg className="fl-marker-shape" viewBox="0 0 24 24" focusable="false">
      {health === "degraded" && <polygon points="12,2 23,22 1,22" />}
      {health === "failed" && <path d="M5 2 12 9 19 2 22 5 15 12 22 19 19 22 12 15 5 22 2 19 9 12 2 5Z" />}
      {health === "unverified" && <>
        <defs><pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse"><path className="fl-marker-hatch" d="M-1 1 1-1M0 4 4 0M3 5 5 3" /></pattern></defs>
        <rect x="2" y="2" width="20" height="20" />
        <rect x="2" y="2" width="20" height="20" fill={`url(#${hatchId})`} />
      </>}
    </svg>
  </span></button>;
}
