import type { ReactNode } from "react";

export interface SkeletonProps { variant?: "row" | "text" | "badge"; className?: string }
export function Skeleton({ variant = "row", className = "" }: SkeletonProps) {
  return <span className={`fl-skeleton ${className}`} data-variant={variant} aria-hidden="true"><span /></span>;
}
export interface EmptyStateProps { title: string; description: string; action?: ReactNode }
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return <section className="fl-empty-state"><h3>{title}</h3><p>{description}</p>{action}</section>;
}
export interface CardProps { children: ReactNode; variant?: "raised" | "subtle" | "divided"; selected?: boolean; className?: string }
export function Card({ children, variant = "raised", selected = false, className = "" }: CardProps) {
  return <div className={`fl-card ${className}`} data-variant={variant} data-selected={selected || undefined}>{children}</div>;
}
