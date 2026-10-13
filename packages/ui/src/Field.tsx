import type { ReactNode } from "react";

interface FieldProps { id: string; label: string; helper?: string | undefined; error?: string | undefined; lang?: string | undefined; children: ReactNode }

export function Field({ id, label, helper, error, lang, children }: FieldProps) {
  return <div className="fl-field" lang={lang}>
    <label htmlFor={id}>{label}</label>
    {children}
    {(error ?? helper) && <p id={`${id}-message`} className={error ? "fl-error" : "fl-helper"}>{error && <span aria-hidden="true">! </span>}{error ?? helper}</p>}
  </div>;
}
