# Shared UI (FL-79)

`@fieldloop/ui` supplies React components built on Radix UI with Tailwind v4 and
tokens generated from the root `DESIGN.md`. Consumers import the compiled CSS once:

```tsx
import "@fieldloop/ui/styles.css";
import { Button, Input, HealthBadge } from "@fieldloop/ui";

<Button variant="secondary" size="lg">Inspect Evidence</Button>
<Input label="Chainage" type="number" helper="SYNTHETIC · metres" />
<HealthBadge health="degraded" />
```

The host loads IBM Plex Sans Thai (400, 500, 600) and IBM Plex Mono. The preview
demonstrates those fonts through the web app's existing Fontsource dependencies.
`tokens.css` is available separately for existing applications; `theme.css` exposes
the generated Tailwind theme for consumers that compile their own utilities.
`styles.css` already includes tokens and the compiled shared component styles.

## Components

| Group | Exports | Behaviour |
| --- | --- | --- |
| Controls (FL-169) | `Button`, `Input`, `Textarea`, `Select`, `Combobox`, `MultiSelect`, `Tabs` | Named controls, errors linked to inputs, disabled/loading states, Radix keyboard behaviour. Select automatically uses searchable Combobox above ten options. |
| Feedback (FL-170) | `Modal`, `ToastProvider`, `Toast`, `Skeleton`, `EmptyState`, `Card` | Trapped/restored modal focus; approval layout blocks scrim dismissal and Enter activation. Info/success toasts expire after six seconds with hover/focus pause; warning/error remain until dismissed. |
| Domain/shell (FL-171) | `HealthBadge`, `ActionLevelBadge`, `MapMarker`, `Navigation`, `TopBar`, `SimulationBanner` | Health shape + text; lowercase glossary values (`healthy`, `l1`) with display labels. Named markers have 44-unit hit targets. Rail/drawer/bottom navigation; permanent SIMULATION banner. |

Controlled values and open states belong to the host. Labels, descriptions,
placeholders, search messages and notification labels are supplied by the host's
i18n layer. Mark mixed-language content with `lang`; Select, Modal and Toast also
carry that value into their portals. Button defaults to `type="button"`;
forms explicitly opt into submit. Numbers, IDs, timestamps and Chainage use
`fl-mono`, including numeric Input and Action Level badges.
Named disabled Select/Combobox/MultiSelect controls are omitted from native form
submission. Thai prose uses dictionary line breaking; apply `fl-break-identifier`
only to IDs and URLs that need arbitrary wrapping.

Set `document.documentElement.dataset.theme` to `light` or `dark`. With no explicit
theme, the kit follows `prefers-color-scheme`. Set the theme on the document root
so Radix portals use the same variables. Reduced motion disables pulses, shimmer
and loading animation. Coarse pointers get at least 44-unit controls; use `size="lg"`
or `fieldSize="lg"` for 48-unit field/crisis controls.
Modal and Toast use `base` entry/exit opacity motion with `enter`/`exit` easing;
menus and tooltips open with `fast`/`standard` motion. Reduced motion removes these
animations. Failed-marker outlines remain visible on both dark surface levels,
while all marker fills retain their canonical Health colours.

`Modal` is a layout primitive, not an approval service. Its `approval` option moves
initial focus to its title, traps focus, preserves Escape/Cancel and prevents Enter
from implicitly executing a consequential action (Space remains available).
Consumers must supply payload, reason, forced re-login, two-person checks and
server validation in FL-96. Do not use Toast as the sole record of approval outcomes.
Production maps need a list equivalent alongside `MapMarker` (FL-77).

## Preview and tests

```bash
pnpm install --frozen-lockfile
pnpm --filter @fieldloop/ui build
pnpm --filter @fieldloop/web dev
# Open http://127.0.0.1:5173/ui-preview.html
pnpm --filter @fieldloop/ui test
pnpm --filter @fieldloop/web exec playwright install chromium
pnpm --filter @fieldloop/web test:ui
```

The standalone preview is a development-only Vite entry with no API access. It is
not part of the default SPA build and carries `noindex, nofollow`. It contains only
labelled SYNTHETIC/SIMULATION component fixtures. Screen-specific implementations
remain with their owning issues.

Browser checks run axe for all visible components and open Select/Combobox/
MultiSelect/Modal/Toast portals in Light/Dark at 390 and 1280 widths. They also cover
keyboard selection, disabled tabs, modal focus/Enter/scrim handling, toast timing,
Thai line-height, 320-width reflow, touch targets and theme overrides. Screenshots
are in `apps/web/e2e/evidence/ui-kit-*.png`. Actual VoiceOver/NVDA checks still require
a human; browser accessibility checks do not replace them.

## Canonical Stitch verification (12 October 2026)

The kit was compared with root `DESIGN.md` and the current canonical references in
[FieldLoop-v2](https://stitch.withgoogle.com/projects/7888686501883489313), selected
from [the verified manifest](../../docs/design/redesign/manifest.json):

| Reference | Current screen ID |
| --- | --- |
| Map Light / Dark | `5948747683069634041` / `7631654295750903555` |
| Approval Light / Dark | `12353232703741438240` / `6802810922368815876` |
| Field capture Light | `13517614703790346409` |

Fresh MCP metadata, downloaded HTML and screenshots were inspected. All five HTML
SHA-256 values matched the manifest. Canonical palette, IBM Plex typography,
button geometry/hover states, the 56-unit desktop Header and FieldLoop-v2 wordmark,
and distinct triangle/cross/hatched-square marker anchors guide this shared kit.
Stitch's automatically derived theme metadata differs from its canonical guidance;
root `DESIGN.md` remains the token source. Static artboards cannot verify runtime
focus, form semantics or animation, which are covered by the component browser suite.

The suite has 19 cases, including native form submission, Thai prose/identifier
reflow, feedback/menu/tooltip motion, button geometry and direct SVG boundary
contrast in system/explicit dark mode. Updated [Light markers](../../apps/web/e2e/evidence/ui-kit-markers-light.png),
[Dark markers](../../apps/web/e2e/evidence/ui-kit-markers-dark.png) and
[Thai modal at 320](../../apps/web/e2e/evidence/ui-kit-thai-320.png) supplement the
catalogue screenshots. Screen-specific layouts remain with the consuming issues.
