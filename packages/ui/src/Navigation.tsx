import type { ReactNode } from "react";
import { Tooltip } from "radix-ui";

export interface NavigationItem { href: string; label: string; icon: ReactNode; active?: boolean; disabled?: boolean; disabledReason?: string }
export interface NavigationProps { label: string; items: readonly NavigationItem[]; variant?: "rail" | "drawer" | "bottom" }
export function Navigation({ label, items, variant = "rail" }: NavigationProps) {
  return <Tooltip.Provider><nav aria-label={label} className="fl-nav" data-variant={variant}>
    {items.filter(item => !item.disabled || item.disabledReason).map(item => {
      if (item.disabled) return <span key={item.href} className="fl-nav-disabled" aria-disabled="true"><span aria-hidden="true">{item.icon}</span>{item.label}<span>{item.disabledReason}</span></span>;
      const link = <a href={item.href} className="fl-nav-link" aria-current={item.active ? "page" : undefined} aria-label={item.label}><span aria-hidden="true">{item.icon}</span><span className="fl-nav-label">{item.label}</span></a>;
      return variant === "rail" ? <Tooltip.Root key={item.href}><Tooltip.Trigger asChild>{link}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="fl-tooltip">{item.label}</Tooltip.Content></Tooltip.Portal></Tooltip.Root> : <span key={item.href}>{link}</span>;
    })}
  </nav></Tooltip.Provider>;
}

export interface TopBarProps { children?: ReactNode; homeHref?: string }
export function TopBar({ children, homeHref = "/map" }: TopBarProps) {
  return <header className="fl-top-bar"><a href={homeHref} className="fl-wordmark" aria-label="FieldLoop">Field<span>Loop</span></a><div className="fl-top-actions">{children}</div></header>;
}

export interface SimulationBannerProps { scenario: string; speed: string; label?: string; scenarioLabel?: string }
export function SimulationBanner({ scenario, speed, label = "SIMULATION", scenarioLabel = "Scenario" }: SimulationBannerProps) {
  return <div className="fl-simulation-banner"><strong>{label}</strong><span> · {scenarioLabel}: {scenario} · </span><span className="fl-mono">{speed}</span></div>;
}
