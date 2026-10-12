import { useRef } from "react";
import type { ReactNode } from "react";
import { Dialog } from "radix-ui";
import { Button } from "./Button.js";

export interface ModalProps {
  trigger: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
  approval?: boolean;
  closeLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function Modal({ trigger, title, description, children, footer, approval = false, closeLabel = "Cancel", open, onOpenChange }: ModalProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="fl-scrim" /><Dialog.Content className="fl-modal" data-approval={approval || undefined}
      onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus(); }}
      onPointerDownOutside={event => { if (approval) event.preventDefault(); }}
      onInteractOutside={event => { if (approval) event.preventDefault(); }}
      onKeyDown={event => {
        // Consequential buttons are activated with Space or an explicit pointer action.
        if (approval && event.key === "Enter" && !(event.target instanceof HTMLTextAreaElement)) event.preventDefault();
      }}>
      <Dialog.Title ref={heading} tabIndex={-1} className="fl-modal-title">{title}</Dialog.Title>
      <Dialog.Description className="fl-helper">{description}</Dialog.Description>
      <div className="fl-modal-body">{children}</div>
      <footer className="fl-modal-footer"><Dialog.Close asChild><Button variant="secondary">{closeLabel}</Button></Dialog.Close>{footer}</footer>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
