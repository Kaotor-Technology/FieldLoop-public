---
version: alpha
name: FieldLoop Field Console
description: >-
  Design system for AI-Harness Living Bowtie (FieldLoop v2), a map-first risk and
  Gen AI guardrail console for critical infrastructure in Southeast Asia.
  English-first with full Thai support. Light and dark modes.
colors:
  # Brand and interaction
  primary: "#14604E"
  primary-hover: "#0F4F40"
  primary-active: "#0B3F33"
  primary-subtle: "#E6F2EC"
  on-primary: "#FFFFFF"
  secondary: "#102E2B"
  on-secondary: "#FFFFFF"
  on-secondary-muted: "#B6CEC6"
  brand-mint: "#7FCEAE"
  focus: "#A97918"
  # Neutral (sage) scale
  neutral-0: "#FFFFFF"
  neutral-50: "#F3F5F2"
  neutral-100: "#E9EEE8"
  neutral-200: "#DCE5DB"
  neutral-300: "#B7C7BE"
  neutral-400: "#7E9289"
  neutral-500: "#5E7469"
  neutral-600: "#4A6158"
  neutral-700: "#354C44"
  neutral-900: "#18332F"
  # Semantic
  success: "#1E7A4C"
  success-subtle: "#E7F4EC"
  warning: "#8A5300"
  warning-subtle: "#FDF1DC"
  error: "#A12B1B"
  error-hover: "#8A2416"
  error-subtle: "#FFF1EC"
  info: "#1D5E8C"
  info-subtle: "#E8F1F8"
  simulation: "#7A5A12"
  simulation-subtle: "#F5F0DE"
  # Barrier Health and risk (map and matrix fills)
  health-degraded: "#D98E04"
  health-failed: "#C2361F"
  health-unverified: "#A3ADA8"
  risk-intolerable: "#B42318"
  risk-alarp: "#E3A21A"
  risk-acceptable: "#7FBF95"
  rain-low: "#DCEBF3"
  rain-high: "#1D5E8C"
  # Dark mode
  dark-canvas: "#0B1F1D"
  dark-surface: "#102E2B"
  dark-surface-raised: "#173A36"
  dark-surface-disabled: "#1E433E"
  dark-border: "#2A4F49"
  dark-outline: "#6E938A"
  dark-on-surface: "#E6EFEB"
  dark-on-surface-muted: "#A9C0B7"
  dark-primary: "#7FCEAE"
  dark-primary-hover: "#9ADBC0"
  dark-on-primary: "#0B1F1D"
  dark-success: "#6FCF9A"
  dark-warning: "#F2B54A"
  dark-error: "#FF8A73"
  dark-info: "#7DB8E8"
  dark-focus: "#E0B44A"
  dark-simulation: "#E8CF8A"
  dark-simulation-subtle: "#2A2610"
typography:
  display:
    fontFamily: IBM Plex Sans Thai
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: 0em
  headline-lg:
    fontFamily: IBM Plex Sans Thai
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.3
  headline-md:
    fontFamily: IBM Plex Sans Thai
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.35
  headline-sm:
    fontFamily: IBM Plex Sans Thai
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.4
  body-lg:
    fontFamily: IBM Plex Sans Thai
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.65
  body-md:
    fontFamily: IBM Plex Sans Thai
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: IBM Plex Sans Thai
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.55
  label-lg:
    fontFamily: IBM Plex Sans Thai
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.3
  label-md:
    fontFamily: IBM Plex Sans Thai
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.3
  label-sm:
    fontFamily: IBM Plex Sans Thai
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0.04em
  mono-lg:
    fontFamily: IBM Plex Mono
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.2
    fontFeature: '"tnum" 1, "zero" 1'
  mono-md:
    fontFamily: IBM Plex Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: '"tnum" 1, "zero" 1'
  mono-sm:
    fontFamily: IBM Plex Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: '"tnum" 1'
rounded:
  none: 0px
  xs: 2px
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
spacing:
  space-0: 0px
  space-1: 4px
  space-2: 8px
  space-3: 12px
  space-4: 16px
  space-5: 20px
  space-6: 24px
  space-8: 32px
  space-10: 40px
  space-12: 48px
  space-16: 64px
  gutter: 16px
  gutter-wide: 24px
  section-gap: 32px
  page-margin-mobile: 16px
  page-margin-desktop: 24px
  max-width-document: 1280px
  max-width-reading: 720px
  top-bar-height: 56px
  nav-rail-width: 64px
  nav-drawer-width: 248px
  context-panel-width: 400px
  context-panel-min: 360px
  context-panel-max: 520px
  timeline-height: 56px
  bottom-tab-height: 64px
  control-sm: 32px
  control-md: 40px
  control-lg: 48px
  touch-target: 44px
  touch-target-field: 48px
  border-hairline: 1px
  indicator-width: 2px
  focus-ring-width: 3px
  focus-ring-offset: 2px
  bowtie-top-event-width: 240px
  strip-view-height: 160px
  list-pane-width: 320px
  context-panel-wide: 480px
  chat-session-list-width: 280px
  chat-sources-pane-width: 360px
  breakpoint-sm: 600px
  breakpoint-md: 840px
  breakpoint-lg: 1200px
  breakpoint-xl: 1600px
elevation:
  level-0: "none"
  level-1: "0 1px 2px rgba(16, 46, 43, 0.06)"
  level-2: "0 4px 20px rgba(16, 46, 43, 0.08)"
  level-3: "0 12px 32px rgba(16, 46, 43, 0.14)"
  level-4: "0 24px 64px rgba(16, 46, 43, 0.22)"
  dark-level-3: "0 12px 32px rgba(5, 15, 14, 0.55)"
  dark-level-4: "0 24px 64px rgba(5, 15, 14, 0.65)"
motion:
  duration-ms:
    instant: 80
    fast: 150
    base: 220
    slow: 320
    map: 700
    pulse: 1600
  easing:
    standard: "cubic-bezier(0.2, 0, 0, 1)"
    enter: "cubic-bezier(0, 0, 0.2, 1)"
    exit: "cubic-bezier(0.4, 0, 1, 1)"
    emphasized: "cubic-bezier(0.3, 0, 0, 1)"
  spring-sheet:
    stiffness: 280
    damping: 32
components:
  # Buttons
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
    padding: "{spacing.space-4}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
    textColor: "{colors.on-primary}"
  button-primary-disabled:
    backgroundColor: "{colors.neutral-100}"
    textColor: "{colors.neutral-600}"
  button-secondary:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
    padding: "{spacing.space-4}"
  button-secondary-hover:
    backgroundColor: "{colors.neutral-100}"
    textColor: "{colors.neutral-900}"
  button-ghost:
    backgroundColor: "{colors.neutral-50}"
    textColor: "{colors.primary}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
    padding: "{spacing.space-3}"
  button-ghost-hover:
    backgroundColor: "{colors.primary-subtle}"
    textColor: "{colors.primary}"
  button-danger:
    backgroundColor: "{colors.error}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
    padding: "{spacing.space-4}"
  button-danger-hover:
    backgroundColor: "{colors.error-hover}"
    textColor: "{colors.on-primary}"
  button-sm:
    height: "{spacing.control-sm}"
    padding: "{spacing.space-3}"
    typography: "{typography.label-md}"
  button-lg:
    height: "{spacing.control-lg}"
    padding: "{spacing.space-5}"
    typography: "{typography.label-lg}"
  focus-ring:
    backgroundColor: "{colors.focus}"
    size: "{spacing.focus-ring-width}"
  # Inputs and selects
  input:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
    padding: "{spacing.space-3}"
  input-border:
    backgroundColor: "{colors.neutral-400}"
    size: "{spacing.border-hairline}"
  input-label:
    textColor: "{colors.neutral-900}"
    typography: "{typography.label-md}"
  input-helper:
    textColor: "{colors.neutral-500}"
    typography: "{typography.body-sm}"
  input-focus:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
  input-error:
    backgroundColor: "{colors.error-subtle}"
    textColor: "{colors.error}"
  input-disabled:
    backgroundColor: "{colors.neutral-100}"
    textColor: "{colors.neutral-600}"
  select:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
    padding: "{spacing.space-3}"
  select-menu:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-1}"
  select-option-selected:
    backgroundColor: "{colors.primary-subtle}"
    textColor: "{colors.primary}"
  # Containers
  card:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-5}"
  card-divider:
    backgroundColor: "{colors.neutral-200}"
    size: "{spacing.border-hairline}"
  card-subtle:
    backgroundColor: "{colors.neutral-50}"
    textColor: "{colors.neutral-700}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-4}"
  modal:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    rounded: "{rounded.xl}"
    padding: "{spacing.space-6}"
    width: "{spacing.max-width-reading}"
  modal-title:
    textColor: "{colors.neutral-900}"
    typography: "{typography.headline-md}"
  approval-payload:
    backgroundColor: "{colors.neutral-50}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.mono-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.space-4}"
  context-panel:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    width: "{spacing.context-panel-width}"
    padding: "{spacing.space-5}"
  # Navigation
  nav-top-bar:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-secondary}"
    height: "{spacing.top-bar-height}"
    padding: "{spacing.page-margin-desktop}"
  nav-brand-mark:
    textColor: "{colors.brand-mint}"
    typography: "{typography.headline-md}"
  nav-rail:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-secondary-muted}"
    width: "{spacing.nav-rail-width}"
  nav-rail-item-active:
    backgroundColor: "{colors.neutral-900}"
    textColor: "{colors.brand-mint}"
    rounded: "{rounded.md}"
    size: "{spacing.touch-target}"
  nav-drawer:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-secondary}"
    width: "{spacing.nav-drawer-width}"
  nav-bottom-tab:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-600}"
    height: "{spacing.bottom-tab-height}"
  nav-bottom-tab-active:
    backgroundColor: "{colors.primary-subtle}"
    textColor: "{colors.primary}"
  tab:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-600}"
    typography: "{typography.label-lg}"
    height: "{spacing.control-md}"
  tab-active:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.primary}"
  # Tables and lists
  table-header:
    backgroundColor: "{colors.neutral-50}"
    textColor: "{colors.neutral-600}"
    typography: "{typography.label-sm}"
    height: "{spacing.control-md}"
  table-row:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.body-md}"
    height: "{spacing.control-lg}"
  table-row-hover:
    backgroundColor: "{colors.neutral-100}"
    textColor: "{colors.neutral-900}"
  table-row-selected:
    backgroundColor: "{colors.primary-subtle}"
    textColor: "{colors.neutral-900}"
  table-cell-numeric:
    textColor: "{colors.neutral-900}"
    typography: "{typography.mono-md}"
  list-item:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.body-md}"
    padding: "{spacing.space-3}"
    height: "{spacing.touch-target-field}"
  list-item-meta:
    textColor: "{colors.neutral-500}"
    typography: "{typography.mono-sm}"
  # Feedback
  toast-info:
    backgroundColor: "{colors.info-subtle}"
    textColor: "{colors.info}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-4}"
  toast-success:
    backgroundColor: "{colors.success-subtle}"
    textColor: "{colors.success}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-4}"
  toast-warning:
    backgroundColor: "{colors.warning-subtle}"
    textColor: "{colors.warning}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-4}"
  toast-error:
    backgroundColor: "{colors.error-subtle}"
    textColor: "{colors.error}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-4}"
  simulation-banner:
    backgroundColor: "{colors.simulation-subtle}"
    textColor: "{colors.simulation}"
    typography: "{typography.label-sm}"
    height: "{spacing.space-8}"
  empty-state:
    backgroundColor: "{colors.neutral-50}"
    textColor: "{colors.neutral-700}"
    typography: "{typography.body-md}"
    padding: "{spacing.space-10}"
    rounded: "{rounded.lg}"
  empty-state-title:
    textColor: "{colors.neutral-900}"
    typography: "{typography.headline-sm}"
  skeleton:
    backgroundColor: "{colors.neutral-200}"
    rounded: "{rounded.sm}"
  skeleton-highlight:
    backgroundColor: "{colors.neutral-100}"
  # Domain: Barrier Health, risk, map
  badge-healthy:
    backgroundColor: "{colors.success-subtle}"
    textColor: "{colors.success}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: "{spacing.space-2}"
  badge-degraded:
    backgroundColor: "{colors.warning-subtle}"
    textColor: "{colors.warning}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: "{spacing.space-2}"
  badge-failed:
    backgroundColor: "{colors.error-subtle}"
    textColor: "{colors.error}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: "{spacing.space-2}"
  badge-unverified:
    backgroundColor: "{colors.neutral-100}"
    textColor: "{colors.neutral-600}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: "{spacing.space-2}"
  badge-action-level:
    backgroundColor: "{colors.info-subtle}"
    textColor: "{colors.info}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.xs}"
    padding: "{spacing.space-1}"
  map-marker-degraded:
    backgroundColor: "{colors.health-degraded}"
    textColor: "{colors.neutral-900}"
    size: "{spacing.space-6}"
  map-marker-failed:
    backgroundColor: "{colors.health-failed}"
    textColor: "{colors.on-primary}"
    size: "{spacing.space-6}"
  map-marker-unverified:
    backgroundColor: "{colors.health-unverified}"
    textColor: "{colors.neutral-900}"
    size: "{spacing.space-6}"
  risk-cell-intolerable:
    backgroundColor: "{colors.risk-intolerable}"
    textColor: "{colors.on-primary}"
    typography: "{typography.mono-md}"
    size: "{spacing.space-10}"
  risk-cell-alarp:
    backgroundColor: "{colors.risk-alarp}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.mono-md}"
    size: "{spacing.space-10}"
  risk-cell-acceptable:
    backgroundColor: "{colors.risk-acceptable}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.mono-md}"
    size: "{spacing.space-10}"
  map-rain-low:
    backgroundColor: "{colors.rain-low}"
    textColor: "{colors.neutral-900}"
  map-rain-high:
    backgroundColor: "{colors.rain-high}"
    textColor: "{colors.on-primary}"
  map-segment-border:
    backgroundColor: "{colors.neutral-300}"
    size: "{spacing.space-1}"
  timeline-bar:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.mono-sm}"
    height: "{spacing.timeline-height}"
  metric-value:
    textColor: "{colors.neutral-900}"
    typography: "{typography.mono-lg}"
  page-title:
    textColor: "{colors.neutral-900}"
    typography: "{typography.display}"
  section-title:
    textColor: "{colors.neutral-900}"
    typography: "{typography.headline-lg}"
  body-long:
    textColor: "{colors.neutral-900}"
    typography: "{typography.body-lg}"
    width: "{spacing.max-width-reading}"
  page-container:
    backgroundColor: "{colors.neutral-50}"
    textColor: "{colors.neutral-900}"
    width: "{spacing.max-width-document}"
    padding: "{spacing.page-margin-desktop}"
  # Agent Chat
  chat-thread:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    width: "{spacing.max-width-reading}"
    padding: "{spacing.space-4}"
  chat-message-user:
    backgroundColor: "{colors.primary-subtle}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-3}"
  chat-message-agent:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.body-lg}"
    padding: "{spacing.space-0}"
  chat-agent-name:
    textColor: "{colors.primary}"
    typography: "{typography.label-md}"
  chat-handoff:
    backgroundColor: "{colors.neutral-50}"
    textColor: "{colors.neutral-600}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: "{spacing.space-2}"
  chat-step:
    backgroundColor: "{colors.neutral-50}"
    textColor: "{colors.neutral-700}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.space-3}"
  chat-step-tool-name:
    textColor: "{colors.neutral-900}"
    typography: "{typography.mono-sm}"
  chat-guardrail-notice:
    backgroundColor: "{colors.info-subtle}"
    textColor: "{colors.info}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.space-3}"
  chat-guardrail-converted:
    backgroundColor: "{colors.warning-subtle}"
    textColor: "{colors.warning}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.space-3}"
  chat-guardrail-blocked:
    backgroundColor: "{colors.error-subtle}"
    textColor: "{colors.error}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.space-3}"
  chat-citation-chip:
    backgroundColor: "{colors.info-subtle}"
    textColor: "{colors.info}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.full}"
    padding: "{spacing.space-1}"
  chat-known-block:
    backgroundColor: "{colors.neutral-50}"
    textColor: "{colors.neutral-700}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.space-3}"
  chat-artifact-card:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-4}"
  chat-incomplete:
    backgroundColor: "{colors.warning-subtle}"
    textColor: "{colors.warning}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.space-3}"
  chat-composer:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: "{spacing.space-3}"
    height: "{spacing.control-lg}"
  chat-context-chip:
    backgroundColor: "{colors.neutral-100}"
    textColor: "{colors.neutral-700}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: "{spacing.space-2}"
  chat-suggestion:
    backgroundColor: "{colors.neutral-50}"
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-3}"
  chat-session-list:
    backgroundColor: "{colors.neutral-50}"
    textColor: "{colors.neutral-900}"
    width: "{spacing.chat-session-list-width}"
  chat-sources-pane:
    backgroundColor: "{colors.neutral-0}"
    textColor: "{colors.neutral-900}"
    width: "{spacing.chat-sources-pane-width}"
  dark-chat-message-user:
    backgroundColor: "{colors.dark-surface-raised}"
    textColor: "{colors.dark-on-surface}"
  # Dark mode
  dark-page:
    backgroundColor: "{colors.dark-canvas}"
    textColor: "{colors.dark-on-surface}"
  dark-card:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-on-surface}"
    rounded: "{rounded.lg}"
    padding: "{spacing.space-5}"
  dark-card-divider:
    backgroundColor: "{colors.dark-border}"
    size: "{spacing.border-hairline}"
  dark-card-meta:
    backgroundColor: "{colors.dark-surface-raised}"
    textColor: "{colors.dark-on-surface-muted}"
  dark-button-primary:
    backgroundColor: "{colors.dark-primary}"
    textColor: "{colors.dark-on-primary}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
  dark-button-primary-hover:
    backgroundColor: "{colors.dark-primary-hover}"
    textColor: "{colors.dark-on-primary}"
  dark-button-disabled:
    backgroundColor: "{colors.dark-surface-disabled}"
    textColor: "{colors.dark-on-surface-muted}"
  dark-input:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-on-surface}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
  dark-input-border:
    backgroundColor: "{colors.dark-outline}"
    size: "{spacing.border-hairline}"
  dark-focus-ring:
    backgroundColor: "{colors.dark-focus}"
    size: "{spacing.focus-ring-width}"
  dark-text-success:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-success}"
  dark-text-warning:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-warning}"
  dark-text-error:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-error}"
  dark-text-info:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-info}"
  dark-simulation-banner:
    backgroundColor: "{colors.dark-simulation-subtle}"
    textColor: "{colors.dark-simulation}"
    typography: "{typography.label-sm}"
---

# Design System: FieldLoop Field Console

## Overview

**What this is.** The UI for AI-Harness Living Bowtie (codename FieldLoop v2), from the product requirements. It is a **map-first operations console**. Barrier-based risk for pipelines, urban flood, OT/cyber and Gen AI is shown on a Geo Command Map. AI assistants draft and check work, and every consequential action is approved by a person.

**Who uses it** (PRD §4):
- **Daily users:** domain risk engineers (pipeline integrity, flood operations, OT security, AI risk), the primary persona, and Barrier Owners (inspection, maintenance, SOC).
- **Approvers:** Technical Authority, Incident Commander, AI Governance Lead, Compliance.
- **Viewers and operators:** executives, control-room operators, district officers.
- **Field staff:** on phones and tablets.

**Brand personality: Precise · Accountable · Calm · Grounded · Candid.** This comes from fieldloop.kaotor.com:
- The tagline is "ตรวจสอบและควบคุมงาน" (check and control work).
- The palette is a deep forest night (`secondary`), a field green (`primary`) and a mint brand mark (`brand-mint`), with an ochre focus ring (`focus`).
- The copy is unusually explicit about what an action does and does not do. Examples from the site: "การส่งข้อมูลไม่ใช่การอนุมัติหรือสั่งงาน" (sending data is not approval or dispatch) and "การปิดหน้าจอไม่ใช่คำสั่ง Stop" (closing the screen is not a Stop command). The UI keeps that candour.

**Platform.** A responsive web app (PWA):
- **Desktop first** for office and control-room work (1280–1920 px, plus wall displays at 1600 px and up).
- **Tablet and phone** for field capture, approvals and crisis updates.
- Deployed on GCP. The demo is on 18 Oct 2026.

**Key screens** (PRD §7–§8):
1. Geo Command Map (home)
2. Context panel (Overview, Bowties, Barriers, Actions, Evidence, Assistant)
3. Bowtie canvas
4. Barrier register
5. Risk Matrix
6. Guardrail view
7. Action Requests and the approval dialog
8. Agent Chat (docked Agent tab and full-screen Agent workspace)
9. Crisis mode
10. Strip (Chainage) view
11. KML import wizard
12. Scenario player and simulation banner
13. Knowledge Library
14. Field capture (mobile)

**Atmosphere.** A calm, cockpit-dense field console. It feels like a well-run control room at night shift: quiet surfaces, one green for action, and colour reserved for the state of the world (Barrier Health, risk, weather).
- **Density:** 7/10 on map and register screens ("Cockpit Dense"), 5/10 on documents and assistant.
- **Variance:** 3/10. Layouts are predictable and anchored, because people act on this screen under pressure.
- **Motion:** 3/10. Restrained, functional and never decorative.

## Colors

The palette has three jobs, and they must never be confused:

1. **Interaction:** the green `primary` only.
2. **World state:** health, risk and weather fills.
3. **Structure:** the sage neutrals.

All text and background pairs below meet **WCAG 2.2 AA** (≥ 4.5:1 for text, ≥ 3:1 for UI boundaries and focus).

### Brand and interaction

- **Field Green (`primary` #14604E):** the single interactive accent, used for primary buttons, links, selected tabs and the active filter. On white it reaches 7.47:1. Hover is **Deep Field (`primary-hover` #0F4F40)** and press is **Root Green (`primary-active` #0B3F33)**. **Selected Tint (`primary-subtle` #E6F2EC)** is the background for selected rows, options and active bottom tabs.
- **Loop Night (`secondary` #102E2B):** the top bar, nav rail and drawer. It anchors the brand and makes the map canvas read as "the world". White on it reaches 14.5:1. **Mist Text (`on-secondary-muted` #B6CEC6)** is for inactive nav labels (8.7:1).
- **Loop Mint (`brand-mint` #7FCEAE):** brand identity only. It is used for the "Loop" half of the wordmark and the active nav indicator, and only on Loop Night or ink (7.3–7.8:1). It is never used for buttons on light surfaces.
- **Ochre Signal (`focus` #A97918):** the keyboard focus ring and nothing else (3.9:1 on white, 3.5:1 on canvas). It is a functional accessibility colour, not a second accent.

### Neutral scale (sage)

One family only. It is a green-tinted grey that matches the brand canvas, and it never mixes with cool or warm greys.

| Token | Hex | Role |
| --- | --- | --- |
| `neutral-0` | #FFFFFF | Surfaces: cards, panels, inputs, modals |
| `neutral-50` | #F3F5F2 | App canvas, table headers, empty states |
| `neutral-100` | #E9EEE8 | Hover rows, disabled fills, skeleton highlight |
| `neutral-200` | #DCE5DB | Dividers, skeleton base, card hairlines |
| `neutral-300` | #B7C7BE | Decorative borders, map Segment outlines (not for inputs) |
| `neutral-400` | #7E9289 | Input and control borders (3.3:1 on white) |
| `neutral-500` | #5E7469 | Secondary text, helper text, metadata (5.0:1 on white, 4.6:1 on canvas) |
| `neutral-600` | #4A6158 | Table header text, inactive tabs, disabled text on `neutral-100` (5.7:1) |
| `neutral-700` | #354C44 | Long-form secondary copy, empty-state body |
| `neutral-900` | #18332F | Primary text: **Field Ink** (13.5:1 on white). Never pure black. |

### Semantic

| Role | Text / icon | Subtle background | Contrast |
| --- | --- | --- | --- |
| Success | `success` #1E7A4C | `success-subtle` #E7F4EC | 4.7:1 |
| Warning | `warning` #8A5300 | `warning-subtle` #FDF1DC | 5.7:1 |
| Error / stop | `error` #A12B1B | `error-subtle` #FFF1EC | 6.6:1 |
| Info | `info` #1D5E8C | `info-subtle` #E8F1F8 | 6.1:1 |
| Simulation | `simulation` #7A5A12 | `simulation-subtle` #F5F0DE | 5.6:1 |

Solid danger buttons use `error` with white text (7.3:1), and `error-hover` #8A2416 on hover (9.0:1).

### World state: Barrier Health, risk and weather

These are **fills for map markers, matrix cells and overlays**. Each one always comes with a **shape or pattern**, so colour is never the only cue (WCAG 1.4.1).

| Meaning | Fill | Paired text | Shape / pattern |
| --- | --- | --- | --- |
| Healthy | `success` (badge only, not pinned on the map) | — | ● circle |
| Degraded | `health-degraded` #D98E04 | Field Ink, 5.0:1 | ▲ triangle |
| Failed | `health-failed` #C2361F | white, 5.5:1 | ✖ cross, plus a slow pulse ring |
| Unverified | `health-unverified` #A3ADA8 | Field Ink, 5.9:1 | ⬚ hatched square |
| Risk intolerable | `risk-intolerable` #B42318 | white, 6.6:1 | Bold cell outline |
| Risk ALARP | `risk-alarp` #E3A21A | Field Ink, 6.1:1 | Diagonal hatch |
| Risk acceptable | `risk-acceptable` #7FBF95 | Field Ink, 6.3:1 | Plain |
| Rain (sequential) | `rain-low` #DCEBF3 → `rain-high` #1D5E8C | Ink / white | Opacity steps of 0.2 |

### Dark mode

Dark mode is a first-class mode for control rooms and night shifts, not an inversion. Depth comes from lighter surfaces instead of shadows.

| Token | Hex | Role | Contrast |
| --- | --- | --- | --- |
| `dark-canvas` | #0B1F1D | App background | — |
| `dark-surface` | #102E2B | Cards, panels, inputs | Text 12.4:1 |
| `dark-surface-raised` | #173A36 | Popovers, menus, raised panels | Muted text 6.4:1 |
| `dark-surface-disabled` | #1E433E | Disabled controls | Muted text 5.7:1 |
| `dark-border` | #2A4F49 | Decorative dividers only | — |
| `dark-outline` | #6E938A | Input and control boundaries | 4.3:1 |
| `dark-on-surface` | #E6EFEB | Primary text | 14.6:1 on canvas |
| `dark-on-surface-muted` | #A9C0B7 | Secondary text | 7.5:1 |
| `dark-primary` | #7FCEAE | Primary action fill (mint becomes the action colour) | `dark-on-primary` #0B1F1D 9.2:1 |
| `dark-primary-hover` | #9ADBC0 | Hover | 10.8:1 |
| `dark-success` / `dark-warning` / `dark-error` / `dark-info` | #6FCF9A / #F2B54A / #FF8A73 / #7DB8E8 | Semantic text on dark surfaces | 7.6 / 7.9 / 6.3 / 6.8:1 |
| `dark-focus` | #E0B44A | Focus ring | 7.5:1 |
| `dark-simulation` on `dark-simulation-subtle` | #E8CF8A on #2A2610 | Simulation banner | 9.9:1 |

Map fills for health and risk stay the same in both modes, because they keep their paired text colours.

- **Do** follow `prefers-color-scheme`, with a manual override saved per user, and offer a "Night shift" shortcut in the top bar.
- **Don't** use `primary` (#14604E) on dark surfaces. It drops below 3:1. Use `dark-primary` instead.

## Typography

**IBM Plex Sans Thai** is the UI family and **IBM Plex Mono** is used for numbers. Both are open-source on Google Fonts.

**Why Plex.**
- Plex Sans Thai is drawn as one system with Plex Sans, so Thai and Latin share the same x-height, stroke weight and rhythm in mixed lines. This matters for lines such as "Barrier CP ที่ KP 45+200 เป็น Degraded".
- Its engineered, industrial character suits a field console.
- Inter and generic system fonts are not used.

**CSS stack:**

```css
font-family: "IBM Plex Sans Thai", "IBM Plex Sans", "Noto Sans Thai", system-ui, sans-serif;
font-family: "IBM Plex Mono", ui-monospace, monospace; /* numbers */
```

Noto Sans Thai, the current brand site font, stays as the fallback.

| Token | Size / line-height | Weight | Use |
| --- | --- | --- | --- |
| `display` | 32 / 1.25 | 600 | Page titles (one per screen) |
| `headline-lg` | 24 / 1.3 | 600 | Section titles, modal titles on large screens |
| `headline-md` | 20 / 1.35 | 600 | Panel titles, modal titles, wordmark |
| `headline-sm` | 17 / 1.4 | 600 | Card titles, empty-state titles |
| `body-lg` | 16 / 1.65 | 400 | Assistant answers, documents, long reading |
| `body-md` | 14 / 1.6 | 400 | Default UI text, table cells, inputs |
| `body-sm` | 13 / 1.55 | 400 | Helper text, captions |
| `label-lg` | 14 / 1.3 | 500 | Buttons, tabs |
| `label-md` | 13 / 1.3 | 500 | Field labels, badges |
| `label-sm` | 12 / 1.3 | 600, +0.04em | Table headers, banners. **Uppercase applies to Latin only.** |
| `mono-lg` | 20 / 1.2 | 500 | Headline numbers (Risk Score, frequency) |
| `mono-md` | 13 / 1.45 | 400 | Chainage, IDs, timestamps, approval payloads, matrix cells |
| `mono-sm` | 12 / 1.4 | 400 | Metadata, Action Level tags, timeline ticks |

**Rules:**
- **Thai line-height is never below 1.5 for body text.** Thai stacks vowels and tone marks above and below the line, and tight leading clips them. Headings use 1.25 or more.
- **No letter-spacing on Thai text.** Only Latin `label-sm` gets +0.04em. Negative tracking is banned, because it collides Thai glyphs.
- **Minimum 13 px for Thai.** Thai tone marks become illegible below that. `mono-sm` at 12 px is used only for Latin digits.
- **All numbers use Plex Mono** with tabular figures (`tnum`) and slashed zero. This covers Chainage (KP 045+200), Risk Score, frequencies (1.2 × 10⁻⁴/yr), timestamps (2026-10-18 09:42) and IDs (BAR-0142). Columns of figures align, and 0 and O cannot be confused.
- **Western Arabic digits** throughout. Thai digits are not used, because they break mixed-script data columns.
- **Line length:** reading text is capped at 65–75 characters (`max-width-reading` 720 px).
- **Thai line breaking:** rely on the browser's dictionary line-breaking. Never use `overflow-wrap: anywhere` on Thai body text, because it splits words mid-syllable. It is allowed only on IDs and URLs.
- Hierarchy comes from weight and colour (Field Ink vs `neutral-500`), not from very large sizes.

## Layout

### Spacing scale

The base unit is **4 px**, and most rhythm happens in **8 px** steps.

| Token | Value | Use |
| --- | --- | --- |
| `space-1` | 4 | Icon-to-label gap, badge padding |
| `space-2` | 8 | Inline gaps, chip padding |
| `space-3` | 12 | Input padding, list-item padding |
| `space-4` | 16 | Default gap, card-subtle padding, `gutter` |
| `space-5` | 20 | Card and panel padding |
| `space-6` | 24 | Modal padding, `gutter-wide`, desktop page margin |
| `space-8` | 32 | `section-gap` between page sections |
| `space-10` / `space-12` / `space-16` | 40 / 48 / 64 | Empty states, large section breaks |

Vertical spacing between sections uses `clamp(24px, 4vw, 32px)`, so it scales down to `space-6` on phones.

### Grid and widths

- **Map screens are full-bleed:** a top bar, a nav rail, the map, and a context panel (`context-panel-width` 400 px, resizable from 360 to 520 px). There is no max-width.
- **Document screens** (registers, Knowledge Library, settings) use a 12-column grid with `gutter-wide` (24 px), centred at `max-width-document` (1280 px).
- **Reading content** (assistant answers, documents, approval payloads) is capped at `max-width-reading` (720 px).
- Use CSS Grid for page structure. No percentage `calc()` hacks.
- Full-height app shells use `min-height: 100dvh`, never `100vh`, to avoid the iOS Safari viewport jump.

### Screen layouts

**1. Geo Command Map (home, MAP-1…15).** Rows, from top to bottom:
1. `nav-top-bar` (56 px): wordmark, global search (Asset / Chainage / place), Domain filter chips, persona switcher, night-shift toggle.
2. `simulation-banner` (32 px), only while a Scenario is running.
3. Main row: `nav-rail` (64 px) | map canvas | `context-panel` (400 px).
4. `timeline-bar` (56 px): scenario player controls on the left, time slider in the centre, alert counts on the right.

Map controls (layers, zoom, legend) sit in a **reserved inset zone** of 16 px inside the map's top-right and bottom-right corners. They never cover the context panel or the timeline. This is the one sanctioned overlay, because a map is itself a canvas.

**2. Context panel.**
- **Header:** Asset name, Chainage range in mono, Risk Matrix cell chip.
- **Tabs:** Overview · Bowties · Barriers · Actions · Evidence · Agent.
- **Body:** scrolls on its own.
- **Footer:** sticky primary action for the current tab.
- **Overview tab:** a vertical stack with dividers instead of cards. It shows the risk summary, Barriers grouped by Health (worst first), and open Action Requests.

**3. Bowtie canvas.** Opens full-screen over the map, with a "Back to map" button that keeps the map position.
- **Three columns:** Threats + Preventive Barriers (left), Top Event (centre, fixed `bowtie-top-event-width`), Mitigative Barriers + Consequences (right).
- **Barrier cells:** show their Health badge and a Degradation Factor sub-row.
- **Legend:** the Explain-score drawer slides in from the right.

**4. Barrier register.**
- **Table:** Health · Barrier · Type (T/O/H) · Owner · Evidence age (mono) · Asset/Chainage (mono) · Bowties.
- **Above the table:** filter chips.
- **Behaviour:** sticky header, 48 px rows, row click opens the context panel.

**5. Risk Matrix.** A 5 × 5 grid of `risk-cell-*` (40 px minimum per cell), with frequency on the y-axis and severity on the x-axis, both labelled in mono. Each cell shows its count. Clicking a cell filters the map.

**6. Guardrail view.**
- **Left:** list of AI Systems.
- **Right:** policy list with Intercept counts, the Held Request queue, and an Intercept detail with the reason and policy ID.
- **Rule:** counts come from real Intercepts. With none yet, the empty state reads "No Intercepts yet".

**7. Action Requests and the approval dialog.**
- **Queue:** a list with the Action Level tag (`badge-action-level`: L0/L1/L2), SLA countdown (mono) and requester.
- **Approval dialog** (`modal`):
  - The title says exactly what will happen.
  - A candid "This does / This does not" pair, in the brand voice.
  - The exact payload in `approval-payload` (mono).
  - A reason field, and step-up re-authentication.
  - Buttons: Approve (primary) and Reject (secondary). Approval is **never** a default-focused button.

**8. Agent Chat** (PRD §7.10, CHAT-1…12). An **agent-style chat**: the work the agent does is visible, and its results are actionable cards.

*Surfaces:*
- **Docked:** the context panel's **Agent** tab. The map stays visible, and "Show on map" results move it.
- **Full-screen Agent workspace** (`/agent`), three columns:
  - `chat-session-list` (`chat-session-list-width`): sessions with title, agent, context and a SIM tag;
  - `chat-thread` (`max-width-reading`), centred;
  - `chat-sources-pane` (`chat-sources-pane-width`): the documents cited in the current answer, the open artifacts, and the full step trace.
- **Mobile:** a full-screen sheet opened from the **Agent** bottom tab.
- **Shortcut:** the top bar's **Ask agent** button and the `/` key open the chat on any screen, docked where a context panel exists and full-screen otherwise.

*Thread anatomy, top to bottom, for each agent turn:*
1. **Header:** the agent avatar (a monogram on `secondary`, never an emoji), `chat-agent-name`, "on behalf of {you}", and SIM or classification tags (CHAT-12).
2. **Step timeline:** a list of `chat-step` rows: plan, then tool calls with `chat-step-tool-name` in mono and a one-line result, then hand-offs as `chat-handoff` pills ("Handed to Code & Standard").
   - Guardrail decisions appear inline in the same list: `chat-guardrail-notice` (redacted, rerouted), `chat-guardrail-converted` (tool call turned into an L1 Action Request), `chat-guardrail-blocked`.
   - While the turn runs, the timeline is expanded and live. When it finishes it collapses to one line ("6 steps · 2 sources · 1 Action Request"), which can be expanded again.
3. **Answer:** `chat-message-agent` in `body-lg`, with no bubble: agent text sits on the surface like a document, and only the user's messages are bubbles.
   - Inline `chat-citation-chip`s are numbered and open the source in the sources pane.
   - A `chat-known-block` holds Known / Unknown / Assumptions.
   - A confidence badge (`badge-action-level` style, text High / Medium / Low plus the reason).
4. **Artifact cards:** `chat-artifact-card` for each Draft, Health Proposal, Action Request (with its L0/L1/L2 badge and SLA), Geo Reference Draft or map result.
   - The primary button is **"Review and approve"**, which opens the approval dialog (Screen 7), or "Show on map".
   - **There is no Approve button inside the chat.**
5. **Incomplete:** when a limit was hit, a `chat-incomplete` banner says what is missing (CHAT-10).
6. **Footer actions** (ghost buttons, text labels): Copy · Retry · Mark correct · Mark incorrect.

*User turn:* `chat-message-user` is a bubble right-aligned at up to 80% of the thread width. Attachment chips show their upload state.

*Composer* (`chat-composer`, sticky at the bottom of the thread):
- **Above the field:** context chips (`chat-context-chip`, removable, for example "Segment KP 40–65", "Zone Z3", "Scenario: Storm B").
- **The field:** multi-line, growing to 6 lines.
- **Below the field:** the agent picker ("Auto" or a named specialist), an attach button, and Send. Send becomes **Stop** (`button-secondary` with a stop icon) while a turn runs.
- **Keys:** Enter sends and Shift+Enter adds a line. During IME composition (Thai input), Enter never sends.

*Empty state:* the agent's name and scope, then 3–4 `chat-suggestion` starter prompts from the agent definition, written as real tasks ("Which Barriers on KP 40–65 are Unverified, and why?"). It shows no sample answers and no invented numbers.

**9. Crisis mode** (MAP-11). The map recentres on the Incident and the context panel becomes the crisis panel: impact zone, failed Barriers, Stakeholders, response-plan steps, and the notification queue. The top bar switches to `error-subtle` with the "Crisis mode" label. The palette does not otherwise change, because calm stays the rule.

**10. Strip (Chainage) view.** A `strip-view-height` band docked above the timeline, with Chainage on the x-axis. Lanes show Segments, Barriers, inspection features and Threat Categories. It stays in sync with the map viewport.

**11. KML import wizard.** A modal with a 4-step stepper: Upload → Preview on map → Map attributes → Choose target. The preview map takes 60% of the modal width. Points beyond the snap tolerance are shown in `warning`.

**12. Knowledge Library.** A document table (title, revision in mono, status badge, classification, owner) and a detail drawer. Superseded documents are visibly struck through, with a "Superseded by" link.

**13. Field capture (mobile).** A full-screen camera or note form. GPS is shown with the snapped Chainage and the offset in metres (mono). There are large 48 px controls and an offline sync badge.

### Responsive

| Breakpoint | Width | Navigation | Map screens | Document screens |
| --- | --- | --- | --- | --- |
| xs (phone) | < `breakpoint-sm` 600 | `nav-bottom-tab` (64 px): Map · Agent · Actions · Capture · More | Map full-screen; context panel becomes a **bottom sheet** (peek 25% → half → full) | Single column; tables become `list-item` rows |
| sm (large phone / small tablet) | 600–839 | Bottom tabs | Bottom sheet, half by default | Single column, 2-column forms |
| md (tablet) | 840–1199 | `nav-rail` (icons + tooltips) | Context panel as an overlay sheet from the right (360 px), dismissible | 8-column grid |
| lg (laptop / desktop) | 1200–1599 | `nav-rail`, expandable to `nav-drawer` 248 px | Split: map + 400 px panel | 12-column grid, max 1280 |
| xl (control room / wall) | ≥ `breakpoint-xl` 1600 | `nav-drawer` open | Three panes: list (`list-pane-width`) + map + panel (`context-panel-wide`) | 12-column grid, max 1280 |

- **Touch targets:** at least `touch-target` (44 px) on touch devices, and `touch-target-field` (48 px) on the field-capture flow and in crisis mode (gloved hands, rain, movement). Controls that are 32 px visually get a 44 px hit area through padding.
- **No horizontal scroll** at any width. Wide tables reflow into lists below 840 px.
- **Type:** `display` scales with `clamp(24px, 3vw + 12px, 32px)`. Body text never goes below 14 px on mobile.
- **Modals** become full-screen sheets below 600 px, with the primary action in a sticky footer above the safe area.

## Elevation & Depth

Depth is mostly **tonal** (canvas → surface → raised) with hairline dividers. Shadows are rare and tinted with Loop Night, never pure black.

| Token | Value | Use |
| --- | --- | --- |
| `level-0` | none | Map canvas, tables, panels docked edge-to-edge |
| `level-1` | 0 1px 2px rgba(16,46,43,0.06) | Inputs, chips, map controls |
| `level-2` | 0 4px 20px rgba(16,46,43,0.08) | Cards that float over the canvas (the brand site's card shadow) |
| `level-3` | 0 12px 32px rgba(16,46,43,0.14) | Popovers, menus, toasts, the context panel when it overlays the map |
| `level-4` | 0 24px 64px rgba(16,46,43,0.22) | Modals and sheets, with a scrim of Loop Night at 48% opacity |
| `dark-level-3` / `dark-level-4` | rgba(5,15,14,0.55 / 0.65) | Dark mode. Mainly use lighter surfaces (`dark-surface-raised`). |

- **Do** use cards only where elevation communicates hierarchy, such as content floating over the map or dashboard summaries. In dense panels, use `card-divider` hairlines and spacing instead.
- **Don't** use glows, coloured shadows or stacked shadows.

## Shapes

The shape language is **engineered and soft-cornered**: firm enough for a technical tool, and friendlier than square corners.

| Token | Value | Use |
| --- | --- | --- |
| `none` | 0 | Docked panels, table cells, map edges |
| `xs` | 2px | Action Level tags, inline code |
| `sm` | 4px | Skeleton blocks, small chips in tables |
| `md` | 8px | Buttons, inputs, selects, nav items |
| `lg` | 12px | Cards, toasts, menus, empty states |
| `xl` | 16px | Modals, bottom sheets (top corners only) |
| `full` | 9999px | Health badges, filter chips, map markers, avatars |

Don't mix radii inside one component. A card is `lg`, and the buttons inside it are `md`.

## Components

Every value below is a token reference from the front matter. Each component lists its **variants**, **sizes** and **states**: default, hover, focus, active, disabled and error.

- **Focus (all interactive components):** `focus-ring` is a ring of `focus-ring-width` in `focus` (dark: `dark-focus-ring`) with a `focus-ring-offset` gap, shown on `:focus-visible` only.
- **Disabled:** uses `neutral-100` / `neutral-600` (dark: `dark-button-disabled`), with `cursor: not-allowed`. It is never conveyed by opacity alone.

### Button

| | |
| --- | --- |
| **Variants** | `button-primary` (one per view; the main commit action), `button-secondary` (white, with an `input-border` hairline in `neutral-400`), `button-ghost` (tertiary, inline actions), `button-danger` (Stop, Reject-and-escalate, destructive) |
| **Sizes** | `button-sm` (32 px, dense tables), default (40 px), `button-lg` (48 px, field and crisis flows) |

| State | Behaviour |
| --- | --- |
| Default | As defined per variant |
| Hover | `button-primary-hover`, `button-secondary-hover`, `button-ghost-hover` or `button-danger-hover` |
| Focus | `focus-ring` |
| Active | `button-primary-active`, plus a 1 px downward translate (tactile press) |
| Disabled | `button-primary-disabled` |
| Loading | The label stays and an inline progress bar runs under it. Width never changes and there is no spinner. |

- **Do** write labels as verbs that state the effect ("Approve and send warning", "Create Command Package").
- **Don't** use "OK", "Submit" or "Continue" for consequential actions.

### Input (text, textarea, number)

- **Structure:** `input-label` above, the field (`input` with an `input-border` hairline), and `input-helper` below.
- **States:**
  - **Default:** as defined.
  - **Hover:** border darkens to `neutral-500`.
  - **Focus:** `input-focus` plus `focus-ring`.
  - **Active (typing):** same as focus.
  - **Disabled:** `input-disabled`.
  - **Error:** `input-error`. The message goes below the field in `error`, with an icon and text and no colour-only signal.
- **Sizes:** default 40 px; 48 px in field flows.
- **Numbers:** Chainage, coordinates and values use `mono-md` inside the field.
- **Don't** use floating labels or placeholder-as-label.

### Select (single, multi, combobox)

- **Closed:** `select`, with a chevron.
- **Open menu:** `select-menu` (`level-3`).
- **Option:** hover is `neutral-100`, selected is `select-option-selected` with a check icon.
- **Other states:** focus, disabled and error are the same as Input.
- **Long lists** (Assets, Barriers) become a searchable combobox above 10 options.

### Card

- **Variants:**
  - `card` (`level-2`): floating content.
  - `card-subtle`: grouped info inside panels, no shadow.
  - Divided list: `card-divider` hairlines, the default in dense panels.
- **States:** hover only on clickable cards (the `card-divider` hairline darkens to `neutral-300`, plus `level-3`); focus `focus-ring`; selected uses a `primary` left bar of `indicator-width`.
- **Don't** lay out three equal cards in a row as a feature grid. Use asymmetric pairs or a divided list.

### Modal and sheet

- **Base:** `modal` (`level-4`, `xl` radius, 720 px maximum), with the title in `modal-title`, a body, and footer actions aligned right (secondary, then primary).
- **Approval variant:**
  - Adds `approval-payload`, the "This does / This does not" pair, and the reason field.
  - There is no close-on-scrim. It closes only with Escape or Cancel, so nobody approves by mis-click.
- **Below 600 px:** a full-screen sheet.
- **Focus:** trapped inside the modal, and returned to the trigger on close.

### Navigation

- **`nav-top-bar`:** Loop Night background, with the `nav-brand-mark` wordmark ("Field" in white, "Loop" in mint).
- **`nav-rail`:** 64 px wide with icons and tooltips. The active item is `nav-rail-item-active` with a mint icon and an ink pill.
- **`nav-drawer`:** 248 px, labels visible.
- **`nav-bottom-tab`:** mobile. The active tab is `nav-bottom-tab-active`.
- **`tab`** for panel sub-navigation: the active tab is `tab-active` with a `primary` underline of `indicator-width`.
- **States:** hover lightens the text to `on-secondary`; focus `focus-ring`; disabled items are hidden rather than greyed, unless an explanation is needed.

### Table and list

- **`table-header`:** sticky, `label-sm`.
- **`table-row`:** 48 px. Hover is `table-row-hover`, selected is `table-row-selected` with a `primary` left bar of `indicator-width`, and focus is `focus-ring` inset.
- **`table-cell-numeric`:** right-aligned mono.
- **Density:** a 40 px density option for registers.
- **Below 840 px:** rows become `list-item` (48 px), with `list-item-meta` for Chainage, timestamps and IDs.
- **Error row:** `error-subtle` background plus an inline message.

### Toast

- **Variants:** `toast-info`, `toast-success`, `toast-warning`, `toast-error` (`level-3`).
- **Placement:** bottom-left on desktop, above the timeline; top on mobile.
- **Timing:** auto-dismiss after 6 s for info and success, with hover pausing the timer. Warning and error stay until dismissed.
- **Content:** one line of what happened plus one action (for example "View Action Request").
- **Never use a toast** for approval outcomes that need an audit trail. Those also appear in the Action Request record.

### Badges and domain markers

- **Health badges:** `badge-healthy`, `badge-degraded`, `badge-failed`, `badge-unverified`, always with their shape icon (● ▲ ✖ ⬚).
- **`badge-action-level`:** L0/L1/L2.
- **Map markers:** `map-marker-degraded`, `map-marker-failed`, `map-marker-unverified` (24 px, with a 44 px hit area). Failed markers carry a slow pulse ring (see Motion).
- **Risk Matrix cells:** `risk-cell-*`.
- **Rain overlay:** `map-rain-low` → `map-rain-high`.
- **Segment outlines:** `map-segment-border`.
- **Live values:** Risk Score and frequency use `metric-value`.

### Simulation banner

`simulation-banner` (dark: `dark-simulation-banner`) is pinned under the top bar whenever any data on screen is simulated. It reads "SIMULATION · Scenario: {name} · {speed}" and cannot be dismissed. Simulated records also carry a small ochre "SIM" tag.

### Agent Chat

- **Variants:**
  - Docked (inside `context-panel`, full panel width, composer pinned to the panel footer).
  - Full-screen (`chat-session-list` + `chat-thread` + `chat-sources-pane`).
  - Mobile sheet (full-screen, composer above the keyboard and safe area, 48 px controls).
- **Message states:**
  - **Streaming:** text appends with a blinking caret; steps appear one by one.
  - **Complete:** the step timeline collapses.
  - **Incomplete:** `chat-incomplete`.
  - **Error:** `toast-error` styling inline, with Retry, and the steps already done stay visible.
  - **Cancelled:** "Stopped by you" in `neutral-500`; any artifacts already created stay and keep their normal approval flow.
- **Composer states:** default; focus (`focus-ring`); disabled while offline or when the session is read-only; error (the attachment was rejected by the Guardrail or the upload failed: `input-error` styling with the reason).
- **Steps:** default; running (a pulsing dot, `pulse` motion); done (check icon); failed (`chat-guardrail-blocked` or error text).
- **Artifact cards:** default; hover (`level-3`); focus `focus-ring`. Disabled is not used: an artifact that is no longer actionable shows its final status instead (Approved, Rejected, Expired).
- **Accessibility:**
  - The thread is a `log` region.
  - Only the **final** answer is announced through `aria-live="polite"`, never each streamed token.
  - Steps are a list with their status in text.
  - The Stop button is reachable by keyboard while streaming.

### Empty state

`empty-state` with an `empty-state-title`, one sentence on why it is empty, and one action that fills it. For example: "No Evidence for this Barrier yet. Upload a report or import KML points." It may include a simple line illustration in `neutral-300`. Never use stock photos or emojis.

### Loading state

`skeleton` blocks that match the exact layout (rows, chips, map-panel sections), with a `skeleton-highlight` shimmer. No circular spinners. The map loads tiles progressively, with a thin progress line of `indicator-width` under the top bar. The assistant streams text, with a blinking caret as the only perpetual loop.

## Motion

Motion explains change in the world: something moved, failed, or arrived. It is never decoration. Tokens live in the front matter `motion` group (durations in milliseconds).

| Token | ms | Easing | Use |
| --- | --- | --- | --- |
| `instant` | 80 | `standard` | Hover colour, button press translate, toggle |
| `fast` | 150 | `standard` | Tooltip, menu open, tab underline, row hover |
| `base` | 220 | `enter` / `exit` | Modal and toast in/out, context panel content swap |
| `slow` | 320 | `emphasized` | Context panel and bottom-sheet slide, crisis-mode transition |
| `map` | 700 | `emphasized` | Map fly-to and fit-bounds |
| `pulse` | 1600 | `standard` (loop) | Failed-marker pulse ring, "Simulation running" dot |

- **Easing curves:**
  - `standard` cubic-bezier(0.2, 0, 0, 1) for most changes.
  - `enter` cubic-bezier(0, 0, 0.2, 1) for appearing elements.
  - `exit` cubic-bezier(0.4, 0, 1, 1) for leaving elements.
  - `emphasized` cubic-bezier(0.3, 0, 0, 1) for large moves.
  - The bottom sheet follows the finger with a spring (`spring-sheet`: stiffness 280, damping 32).
  - Linear easing is not used.
- **Feedback:**
  - A Health change on the map cross-fades the marker over `base` and rings it once.
  - Risk Score changes count to the new value over `slow`, in mono.
  - New list items fade and slide 8 px up, with a 30 ms stagger capped at 6 items.
- **Agent Chat:**
  - Each new step fades in over `fast`.
  - The timeline collapses over `base` when the turn completes.
  - Streamed text appends with no per-token animation; only the caret blinks.
  - Under reduced motion, steps appear without fades, and the caret is static.
- **Page transitions:** cross-fade over `base` between top-level sections. The map never reloads; the panel content swaps.
- **Performance:** animate only `transform` and `opacity`, never layout properties.
- **`prefers-reduced-motion: reduce`:**
  - Every duration drops to `instant` or 0.
  - Map fly-to becomes an instant jump.
  - The pulse ring becomes a static double outline.
  - Count-ups show the final value.
  - Staggers are removed.
  - Shimmer becomes a static `skeleton`.
  - The simulation dot stops blinking.

## Do's and Don'ts

**Do**
- Do keep `primary` green for interaction only. World-state colours (health, risk, rain) never become buttons.
- Do pair every health or risk colour with a shape or pattern, and a text label in lists.
- Do state the effect and the non-effect of consequential actions in plain words, in the brand voice ("Approving sends 3 district warnings. It does not operate any pump.").
- Do render every number, Chainage, timestamp and ID in Plex Mono with tabular figures.
- Do show SIMULATION / SYNTHETIC labels wherever simulated or synthetic data appears.
- Do keep Thai body text at a line-height of 1.5 or more, at 13 px or larger, with no letter-spacing.
- Do meet WCAG AA in both modes, and keep focus visible with the ochre ring.
- Do write UI copy in English and Thai of equal quality. Thai is not a machine-translated afterthought.

**Don't**
- Don't use emojis anywhere in the product UI.
- Don't use Inter, generic system fonts as the primary face, or serif fonts.
- Don't use pure black (#000000). Use Field Ink `neutral-900` or Loop Night.
- Don't use neon, glows, purple/blue AI gradients or gradient text.
- Don't add a second decorative accent. Mint is brand-only on dark, and ochre is focus-only.
- Don't let overlays cover the context panel or timeline. Map controls stay in their reserved insets.
- Don't use the three-equal-cards row, centred marketing heroes, or "By the numbers" panels.
- Don't fabricate metrics in demos or mockups. Show real computed or simulated values, labelled as such, or a `[metric]` placeholder.
- Don't use generic names such as "John Doe" or "Acme". Use the persona role names (Integrity Engineer, Incident Commander).
- Don't use AI copy clichés ("Elevate", "Seamless", "Unleash", "Next-gen") or filler UI ("Scroll to explore").
- Don't use spinners. Don't use custom cursors.
- Don't make Approve the default-focused or Enter-triggered button in approval dialogs.
- Don't put an Approve button in Agent Chat. Artifact cards always link to the approval dialog.
- Don't hide what the agent did. Steps, hand-offs and Guardrail decisions stay inspectable after the answer.
- Don't give the agent a cute persona, mascot or emoji avatar. It is a named tool that works on the user's behalf.

## Assumptions

Decisions that the product requirements do not specify, made here for review:

1. **Brand personality "Precise · Accountable · Calm · Grounded · Candid"** comes from the live site's tagline, its palette and its explicit "X is not Y" copy. The site gives no stated brand values.
2. **Brand colours are reused from fieldloop.kaotor.com:** `secondary` #102E2B, `primary` #14604E, `brand-mint` #7FCEAE, `focus` #A97918, canvas #F3F5F2, ink #18332F and stop #8D2719. The error colour was adjusted to #A12B1B for a stronger solid button. Neutrals were extended into a full sage scale.
3. **IBM Plex Sans Thai + IBM Plex Mono replace the site's system-ui/Noto Sans Thai.** The reasons are a matched Thai/Latin design and better mono numerals; Inter is banned by the design rules. Noto Sans Thai stays as a fallback.
4. **English-first UI** follows PRD Q57 (Southeast Asia audience). The type system is built so that Thai is equally first-class.
5. **Desktop-first** for the console, with phone and tablet as a PWA for field capture, approvals and crisis updates (PRD MAP-13, §4 personas). There are no native apps.
6. **Density 7 / variance 3 / motion 3** instead of the taste skill's creative defaults (variance 8, motion 6). This is a safety-relevant operations tool, where predictability and calm beat novelty.
7. **No marketing hero or landing page** is in scope. The PRD defines an application, and its home is the map (MAP-1).
8. **Healthy Barriers are not pinned on the map,** only shown in lists and badges, following MAP-3. This also keeps green on the map from competing with the green action colour.
9. **Map controls are the one allowed overlay,** in reserved insets. A map is a canvas, so the "no overlapping elements" rule is applied to UI panels, not to map content.
10. **Dark mode uses mint as the action colour,** because Field Green fails contrast on dark surfaces. It follows `prefers-color-scheme`, with a manual "Night shift" toggle.
11. **Field and crisis touch targets are 48 px** (above the 44 px minimum) for gloved or wet hands in the field.
12. **Western Arabic digits only** (no Thai digits), so mixed-script data columns stay aligned.
13. **Approval dialogs disable close-on-scrim and default focus on Approve.** This is an interpretation of PRD AX-2/AX-3 (exact-payload, deliberate approval).
14. **Motion, elevation and breakpoint tokens are extensions:**
    - Breakpoints are stored in `spacing`, because the DESIGN.md spec has no breakpoint group.
    - Shadows go in a custom `elevation` group, and motion in a custom `motion` group with integer milliseconds.
    - These two custom groups pass the linter but are **not emitted by `design.md export`** (v0.4). The front-end build must read them directly or mirror them into CSS variables.
15. **Component borders, shadows and focus rings are expressed as helper components** (`input-border`, `card-divider`, `focus-ring`) using `backgroundColor` and `size`. The spec's component schema has no `borderColor` or `shadow` property.
16. **Agent Chat layout choices:**
    - user messages are bubbles and agent answers are unboxed text;
    - the full-screen workspace has three columns;
    - the `/` shortcut opens the chat;
    - the step timeline auto-collapses when a turn finishes;
    - the agent avatar is a monogram.
   These follow agent-chat conventions and PRD §7.10; the PRD does not prescribe them.
