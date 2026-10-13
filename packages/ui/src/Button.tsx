import type { ButtonHTMLAttributes } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

export function Button({ variant = "primary", size = "md", loading = false, disabled, className = "", children, type = "button", ...props }: ButtonProps) {
  return <button {...props} type={type} className={`fl-button ${className}`} data-variant={variant} data-size={size} disabled={disabled || loading} aria-busy={loading || undefined}>
    {children}{loading && <span className="fl-progress" aria-hidden="true" />}
  </button>;
}
