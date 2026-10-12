import { useId } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

interface FieldProps { label: string; helper?: string; error?: string; fieldSize?: "md" | "lg"; numeric?: boolean }
export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, FieldProps {}
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldProps {}

export function Input({ label, helper, error, fieldSize = "md", numeric = false, id, className = "", "aria-describedby": describedBy, ...props }: InputProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const messageId = `${fieldId}-message`;
  return <div className="fl-field" lang={props.lang}>
    <label htmlFor={fieldId}>{label}</label>
    <input {...props} id={fieldId} className={`fl-input ${numeric || props.type === "number" ? "fl-mono" : ""} ${className}`} data-size={fieldSize} aria-invalid={error ? true : props["aria-invalid"]} aria-describedby={[describedBy, (error ?? helper) ? messageId : undefined].filter(Boolean).join(" ") || undefined} />
    {(error ?? helper) && <p id={messageId} className={error ? "fl-error" : "fl-helper"}>{error && <span aria-hidden="true">! </span>}{error ?? helper}</p>}
  </div>;
}

export function Textarea({ label, helper, error, fieldSize = "md", numeric = false, id, className = "", "aria-describedby": describedBy, ...props }: TextareaProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const messageId = `${fieldId}-message`;
  return <div className="fl-field" lang={props.lang}>
    <label htmlFor={fieldId}>{label}</label>
    <textarea {...props} id={fieldId} className={`fl-input fl-textarea ${numeric ? "fl-mono" : ""} ${className}`} data-size={fieldSize} aria-invalid={error ? true : props["aria-invalid"]} aria-describedby={[describedBy, (error ?? helper) ? messageId : undefined].filter(Boolean).join(" ") || undefined} />
    {(error ?? helper) && <p id={messageId} className={error ? "fl-error" : "fl-helper"}>{error && <span aria-hidden="true">! </span>}{error ?? helper}</p>}
  </div>;
}
