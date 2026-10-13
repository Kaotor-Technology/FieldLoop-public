import type { ReactNode } from "react";
import { Tabs as Primitive } from "radix-ui";

export interface TabItem { value: string; label: string; content: ReactNode; disabled?: boolean }
export interface TabsProps { label: string; items: readonly TabItem[]; value: string; onValueChange: (value: string) => void }
export function Tabs({ label, items, value, onValueChange }: TabsProps) {
  return <Primitive.Root value={value} onValueChange={onValueChange} className="fl-tabs">
    <Primitive.List aria-label={label} className="fl-tab-list">{items.map(item => <Primitive.Trigger key={item.value} value={item.value} disabled={item.disabled ?? false} className="fl-tab">{item.label}</Primitive.Trigger>)}</Primitive.List>
    {items.map(item => <Primitive.Content key={item.value} value={item.value} className="fl-tab-panel">{item.content}</Primitive.Content>)}
  </Primitive.Root>;
}
