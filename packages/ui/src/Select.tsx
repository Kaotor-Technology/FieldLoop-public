import { useEffect, useId, useRef, useState } from "react";
import { Checkbox, Popover, Select as Primitive } from "radix-ui";
import { useInertOutside } from "./useInertOutside.js";
import { Field } from "./Field.js";

export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectProps {
  label: string;
  options: readonly SelectOption[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  helper?: string;
  name?: string;
  searchLabel?: string;
  emptyLabel?: string;
  scrollUpLabel?: string;
  scrollDownLabel?: string;
  lang?: string;
}

export function Select(props: SelectProps) {
  if (props.options.length > 10) return <Combobox {...props} />;
  return <SingleSelect {...props} />;
}

function SingleSelect({ label, options, value, onValueChange, placeholder = "Select an option", disabled = false, error, helper, name, lang, scrollUpLabel = "Scroll options up", scrollDownLabel = "Scroll options down" }: SelectProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const content = useInertOutside(open && !disabled);
  return <Field id={id} label={label} helper={helper} error={error} lang={lang}>
    <Primitive.Root value={value} onValueChange={next => { if (!disabled) onValueChange(next); }} disabled={disabled} open={open && !disabled} onOpenChange={next => setOpen(next && !disabled)} {...(name ? { name } : {})}>
      <Primitive.Trigger id={id} className="fl-input fl-select-trigger" aria-invalid={Boolean(error)} aria-describedby={error || helper ? `${id}-message` : undefined}>
        <Primitive.Value placeholder={placeholder} /><Primitive.Icon aria-hidden="true">⌄</Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal><Primitive.Content ref={content} className="fl-select-menu" position="popper" lang={lang}>
        <Primitive.ScrollUpButton aria-label={scrollUpLabel}>⌃</Primitive.ScrollUpButton>
        <Primitive.Viewport>{options.map(option => <Primitive.Item key={option.value} value={option.value} disabled={option.disabled ?? false} className="fl-option">
          <Primitive.ItemText>{option.label}</Primitive.ItemText><Primitive.ItemIndicator aria-hidden="true">✓</Primitive.ItemIndicator>
        </Primitive.Item>)}</Primitive.Viewport>
        <Primitive.ScrollDownButton aria-label={scrollDownLabel}>⌄</Primitive.ScrollDownButton>
      </Primitive.Content></Primitive.Portal>
    </Primitive.Root>
  </Field>;
}

export function Combobox({ label, options, value, onValueChange, placeholder = "Select an option", disabled = false, error, helper, name, searchLabel = "Search options", emptyLabel = "No matching options", lang }: SelectProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>();
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const input = useRef<HTMLInputElement>(null);
  const matches = options.filter(option => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const enabled = disabled ? [] : matches.filter(option => !option.disabled);
  const activeValue = enabled.some(option => option.value === active) ? active : enabled[0]?.value;
  useEffect(() => {
    if (open && activeValue) document.getElementById(`${id}-option-${options.findIndex(option => option.value === activeValue)}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeValue, id, options]);
  function choose(next: string) { if (disabled) return; onValueChange(next); setOpen(false); }
  return <Field id={id} label={label} helper={helper} error={error} lang={lang}>
    {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
    <Popover.Root open={open && !disabled} onOpenChange={next => { setOpen(next && !disabled); if (next) { setQuery(""); setActive(value); } }}>
      <Popover.Trigger id={id} className="fl-input fl-select-trigger" disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={error || helper ? `${id}-message` : undefined}>
        {options.find(option => option.value === value)?.label ?? placeholder}<span aria-hidden="true">⌄</span>
      </Popover.Trigger>
      <Popover.Portal><Popover.Content className="fl-select-menu" aria-label={label} lang={lang} onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }}>
        <input ref={input} className="fl-input" role="combobox" aria-label={searchLabel} aria-controls={`${id}-list`} aria-expanded={open} aria-autocomplete="list" aria-activedescendant={activeValue ? `${id}-option-${options.findIndex(option => option.value === activeValue)}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setActive(undefined); }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (enabled.length === 0) return;
            const index = enabled.findIndex(option => option.value === activeValue);
            const nextIndex = event.key === "ArrowDown" ? (index + 1) % enabled.length : (index - 1 + enabled.length) % enabled.length;
            setActive(enabled[nextIndex]?.value);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault(); setActive(event.key === "Home" ? enabled[0]?.value : enabled.at(-1)?.value);
          } else if (event.key === "Enter" && activeValue) { event.preventDefault(); choose(activeValue); }
        }} />
        <div id={`${id}-list`} role="listbox" aria-label={label} className="fl-option-list">
          {matches.map(option => <div key={option.value} id={`${id}-option-${options.findIndex(item => item.value === option.value)}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled ?? false} className="fl-option" data-highlighted={option.value === activeValue ? "" : undefined} onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (!option.disabled) setActive(option.value); }} onClick={() => { if (!option.disabled) choose(option.value); }}>{option.label}{option.value === value && <span aria-hidden="true">✓</span>}</div>)}
        </div>
        {matches.length === 0 && <p role="status" className="fl-helper">{emptyLabel}</p>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </Field>;
}

export interface MultiSelectProps extends Omit<SelectProps, "value" | "onValueChange"> { value: readonly string[]; onValueChange: (value: string[]) => void }
export function MultiSelect({ label, options, value, onValueChange, placeholder = "Select options", disabled = false, error, helper, name, searchLabel = "Search options", emptyLabel = "No matching options", lang }: MultiSelectProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const matches = options.filter(option => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <Field id={id} label={label} helper={helper} error={error} lang={lang}>
    {name && value.map(item => <input key={item} type="hidden" name={name} value={item} disabled={disabled} />)}
    <Popover.Root open={open && !disabled} onOpenChange={next => { setOpen(next && !disabled); setQuery(""); }}>
      <Popover.Trigger id={id} className="fl-input fl-select-trigger" disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={error || helper ? `${id}-message` : undefined}>
        <span>{value.length ? options.filter(option => value.includes(option.value)).map(option => option.label).join(", ") : placeholder}</span><span aria-hidden="true">⌄</span>
      </Popover.Trigger>
      <Popover.Portal><Popover.Content className="fl-select-menu" aria-label={label} lang={lang}>
        {options.length > 10 && <input className="fl-input" aria-label={searchLabel} value={query} onChange={event => setQuery(event.target.value)} />}
        <div role="group" aria-label={label} className="fl-option-list">{matches.map(option => <label key={option.value} className="fl-option" data-state={value.includes(option.value) ? "checked" : "unchecked"} data-disabled={disabled || option.disabled ? "" : undefined}>
          <Checkbox.Root className="fl-checkbox" checked={value.includes(option.value)} disabled={disabled || (option.disabled ?? false)} onCheckedChange={checked => { if (!disabled && !option.disabled) onValueChange(checked === true ? [...value, option.value] : value.filter(item => item !== option.value)); }}><Checkbox.Indicator aria-hidden="true">✓</Checkbox.Indicator></Checkbox.Root>{option.label}
        </label>)}</div>
        {matches.length === 0 && <p role="status" className="fl-helper">{emptyLabel}</p>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </Field>;
}
