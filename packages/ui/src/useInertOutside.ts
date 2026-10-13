import { useLayoutEffect, useState } from "react";

const inertOwners = new WeakMap<HTMLElement, { count: number; original: boolean }>();

/** Native inert prevents hidden background controls being reachable by assistive technology. */
export function useInertOutside(open: boolean) {
  const [content, setContent] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open || !content) return;
    const backgrounds: HTMLElement[] = [];
    let branch: HTMLElement = content;
    while (branch.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of parent.children) {
        if (!(sibling instanceof HTMLElement) || sibling === branch || sibling.hasAttribute("data-radix-focus-guard")) continue;
        const owner = inertOwners.get(sibling) ?? { count: 0, original: sibling.inert };
        owner.count += 1;
        inertOwners.set(sibling, owner);
        sibling.inert = true;
        backgrounds.push(sibling);
      }
      if (parent === document.body) break;
      branch = parent;
    }
    return () => {
      for (const element of backgrounds) {
        const owner = inertOwners.get(element);
        if (!owner) continue;
        owner.count -= 1;
        if (owner.count === 0) { element.inert = owner.original; inertOwners.delete(element); }
      }
    };
  }, [open, content]);
  return setContent;
}
