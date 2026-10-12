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
  return <button {...props} type={type} className={`fl-map-marker ${className}`} data-health={health} aria-label={label}><span aria-hidden="true">{healthShapes[health]}</span></button>;
}
