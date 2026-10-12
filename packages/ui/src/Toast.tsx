import type { ReactNode } from "react";
import { Toast as Primitive } from "radix-ui";
import { Button } from "./Button.js";

export interface ToastProviderProps { children: ReactNode; label?: string }
export function ToastProvider({ children, label = "Notification" }: ToastProviderProps) {
  return <Primitive.Provider label={label} duration={6000} swipeDirection="left">
    {children}<Primitive.Viewport className="fl-toast-viewport" />
  </Primitive.Provider>;
}

export interface ToastProps {
  variant: "info" | "success" | "warning" | "error";
  message: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  closeLabel?: string;
  action?: { label: string; altText: string; onClick: () => void };
}

export function Toast({ variant, message, open, onOpenChange, closeLabel = "Dismiss notification", action }: ToastProps) {
  return <Primitive.Root className="fl-toast" data-variant={variant} open={open} onOpenChange={onOpenChange}
    type={variant === "error" || variant === "warning" ? "foreground" : "background"}
    duration={variant === "warning" || variant === "error" ? Infinity : 6000}>
    <Primitive.Title className="fl-toast-message">{message}</Primitive.Title>
    {action && <Primitive.Action asChild altText={action.altText}><Button variant="secondary" onClick={action.onClick}>{action.label}</Button></Primitive.Action>}
    <Primitive.Close asChild><Button variant="ghost" aria-label={closeLabel}>×</Button></Primitive.Close>
  </Primitive.Root>;
}
