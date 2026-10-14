import type { ReactNode } from "react";

const MONO_TOKEN = /^[A-Za-z][A-Za-z-]*-\d+(?:\.\d+)*$|^\d+(?:\.\d+)*$/;
const MONO_PARTS = /([A-Za-z][A-Za-z-]*-\d+(?:\.\d+)*|\b\d+(?:\.\d+)*\b)/g;

export function monoNumericText(value: string): ReactNode {
  return value.split(MONO_PARTS).map((part, index) => MONO_TOKEN.test(part)
    ? <span className="mono" key={index}>{part}</span>
    : part);
}
