import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => { await page.goto("/ui-preview.html"); });

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`components pass axe in ${theme} at ${width} with keyboard-operable portals`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await expect(page.getByRole("heading", { name: "FieldLoop component library" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const audit = async () => expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
      await audit();
      await page.getByRole("combobox", { name: "Evidence type", exact: true }).click();
      await audit();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Source", exact: true }).click();
      await audit();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Sources", exact: true }).click();
      await audit();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Open modal", exact: true }).click();
      await audit();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Open approval layout" }).click();
      await audit();
      await page.keyboard.press("Escape");
      for (const variant of ["info", "success", "warning", "error"]) {
        await page.getByRole("button", { name: `Show ${variant}`, exact: true }).click();
        await expect(page.getByText(`${variant}: SYNTHETIC preview notification`, { exact: true })).toBeVisible();
        // Keep the live notification visible while axe inspects it; timing has its own test.
        await page.getByText(`${variant}: SYNTHETIC preview notification`, { exact: true }).hover();
        await audit();
        await page.getByRole("button", { name: "Dismiss notification" }).click();
      }
      await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "th");
      await expect(page.locator(".preview-heading")).toHaveAttribute("lang", "th");
      await page.getByRole("button", { name: "Open modal", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Inspect Evidence", exact: true })).toHaveAttribute("lang", "en");
      await page.keyboard.press("Escape");
      await audit();
      await page.getByRole("button", { name: "English", exact: true }).click();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `e2e/evidence/ui-kit-${theme}-${width}.png` });
    });
  }
}

test("forms link errors and selects support keyboard search and multi-selection", async ({ page }) => {
  const reason = page.getByRole("textbox", { name: "Required reason" });
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(reason).toHaveAccessibleDescription("Enter a reason.");
  const select = page.getByRole("combobox", { name: "Evidence type", exact: true });
  await select.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("option", { name: "Evidence", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Barrier", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(select).toHaveText(/Barrier/);
  await expect(select).toBeFocused();
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  const source = page.getByRole("button", { name: "Source", exact: true });
  await source.click();
  const search = page.getByRole("combobox", { name: "Search options" });
  await expect(search).toBeFocused();
  await search.fill("zzzz");
  await expect(page.getByRole("status").filter({ hasText: "No matching options" })).toBeVisible();
  await search.press("ArrowDown");
  await search.fill("water");
  await search.press("Enter");
  await expect(source).toHaveText(/Water level/);
  await expect(source).toBeFocused();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("textbox", { name: "Search options" }).fill("rain");
  await page.getByRole("checkbox", { name: "Rain", exact: true }).check();
  await page.getByRole("textbox", { name: "Search options" }).fill("pump");
  await page.getByRole("checkbox", { name: "Pump", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Sources", exact: true })).toHaveText(/Rain, Pump/);
});

test("tabs skip disabled items, modal traps and restores focus, approval layout ignores scrim and Enter", async ({ page }) => {
  const evidence = page.getByRole("tab", { name: "Evidence", exact: true });
  await evidence.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "History", exact: true })).toBeFocused();
  await expect(page.getByRole("tab", { name: "History", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(evidence).toBeFocused();
  const trigger = page.getByRole("button", { name: "Open approval layout" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Consequential action layout" });
  await expect(dialog.getByRole("heading")).toBeFocused();
  await dialog.getByRole("textbox", { name: "Action reason" }).fill("Synthetic reason");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Activate preview action" }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("textbox")).toBeFocused();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("toast timing pauses on hover and warnings persist until dismissed", async ({ page }) => {
  await page.clock.install();
  await page.getByRole("button", { name: "Show info", exact: true }).click();
  const info = page.getByText("info: SYNTHETIC preview notification", { exact: true });
  await info.hover();
  await page.clock.fastForward(7000);
  await expect(info).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(6100);
  await expect(info).not.toBeVisible();
  await page.getByRole("button", { name: "Show warning", exact: true }).click();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(60000);
  await expect(page.getByText("warning: SYNTHETIC preview notification", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(page.getByText("warning: SYNTHETIC preview notification", { exact: true })).not.toBeVisible();
});

test("markers are reachable by keyboard and reduced motion, Thai text and narrow layouts remain usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const marker = page.getByRole("button", { name: "failed Barrier marker", exact: true });
  await marker.focus();
  await marker.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Selected failed" })).toBeVisible();
  expect(await marker.locator("span").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  expect(await page.locator(".fl-skeleton > span").first().evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
  const thai = page.getByRole("textbox", { name: "หมายเหตุ" });
  const style = await thai.evaluate(element => { const css = getComputedStyle(element); return { lineHeight: parseFloat(css.lineHeight) / parseFloat(css.fontSize), spacing: css.letterSpacing }; });
  expect(style.lineHeight).toBeGreaterThanOrEqual(1.5);
  expect(["normal", "0px"]).toContain(style.spacing);
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect((await marker.boundingBox())?.width).toBeGreaterThanOrEqual(44);
  expect((await page.getByRole("button", { name: "Field button" }).boundingBox())?.height).toBeGreaterThanOrEqual(48);
});

test("system theme follows OS and manual light mode overrides it", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const readCanvas = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const dark = await readCanvas();
  await page.getByRole("button", { name: "Night shift" }).click();
  await page.getByRole("button", { name: "Night shift" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await readCanvas()).not.toBe(dark);
});

test("Select nested in a modal restores the active dialog", async ({ page }) => {
  await page.getByRole("button", { name: "Open modal", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Inspect Evidence", exact: true });
  const select = dialog.getByRole("combobox", { name: "Modal category", exact: true });
  await select.click();
  await expect(page.getByRole("option", { name: "Evidence", exact: true })).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("option", { name: "Barrier", exact: true }).click();
  await expect(select).toHaveText(/Barrier/);
  await expect(select).toBeFocused();
  await select.click();
  await expect(page.getByRole("option", { name: "Barrier", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(select).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open modal", exact: true })).toBeFocused();
});

test.describe("touch devices", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 900 } });
  test("compact controls preserve 44-unit targets and field controls preserve 48-unit targets", async ({ page }) => {
    for (const name of ["Compact button", "View Evidence", "Night shift"]) {
      expect((await page.getByRole("button", { name, exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    expect((await page.getByRole("button", { name: "Field button", exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(48);
    expect((await page.getByRole("textbox", { name: "Field input", exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(48);
  });
});

test("disabled variants retain disabled colours in both themes and expose a visible focus ring", async ({ page }) => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(colorScheme === "dark");
    for (const variant of ["secondary", "ghost", "danger"]) {
      const button = page.getByRole("button", { name: `Unavailable ${variant}`, exact: true });
      await expect(button).toBeDisabled();
    }
    await expect.poll(() => page.evaluate(() => {
      const colors = Array.from(document.querySelectorAll('.fl-button:disabled:not([aria-busy="true"])')).map(element => { const css = getComputedStyle(element); return `${css.backgroundColor}|${css.color}`; });
      return colors.length === 4 && new Set(colors).size === 1;
    })).toBe(true);
    const button = page.getByRole("button", { name: "View Evidence", exact: true });
    await button.focus();
    const focus = await button.evaluate(element => { const css = getComputedStyle(element); return { style: css.outlineStyle, width: parseFloat(css.outlineWidth) }; });
    expect(focus.style).toBe("solid");
    expect(focus.width).toBeGreaterThan(0);
  }
});

test("disabled selections are omitted from forms while enabled selections submit their values", async ({ page }) => {
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.getByRole("combobox", { name: "Search options" }).fill("rain");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("textbox", { name: "Search options" }).fill("pump");
  await page.getByRole("checkbox", { name: "Pump", exact: true }).check();
  await page.keyboard.press("Escape");
  const entries = await page.getByRole("form", { name: "Component form" }).evaluate(form => Array.from(new FormData(form as HTMLFormElement).entries()));
  expect(entries).toEqual([["category", "evidence"], ["source", "Rain"], ["sources", "Pump"]]);
});

test("Thai prose retains dictionary wrapping and long identifiers reflow inside modal content", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "Open modal", exact: true }).click();
  const body = page.locator(".fl-modal-body");
  await body.evaluate(element => {
    element.setAttribute("lang", "th");
    const prose = document.createElement("p");
    prose.textContent = "หลักฐานสังเคราะห์สำหรับการตรวจสอบสถานะของสิ่งกีดขวางความเสี่ยง".repeat(4);
    const identifier = document.createElement("code");
    identifier.className = "fl-mono fl-break-identifier";
    identifier.textContent = "SYNTHETIC-".repeat(30);
    element.replaceChildren(prose, identifier);
  });
  expect(await body.locator("p").evaluate(element => getComputedStyle(element).overflowWrap)).toBe("normal");
  expect(await body.locator("code").evaluate(element => element.parentElement !== null && element.scrollWidth <= element.parentElement.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator(".fl-modal").screenshot({ path: "e2e/evidence/ui-kit-thai-320.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show info", exact: true }).click();
  for (const selector of [".fl-toast-message", ".fl-simulation-banner", ".fl-select-trigger > span:first-child", ".fl-nav-disabled"]) {
    expect(await page.locator(selector).first().evaluate(element => { element.setAttribute("lang", "th"); return getComputedStyle(element).overflowWrap; })).toBe("normal");
  }
});

test("modal and toast enter and exit with DESIGN motion and disappear immediately with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    const events: { component: string; state: string | undefined; duration: string; easing: string }[] = [];
    Object.assign(window, { uiMotionEvents: events });
    document.addEventListener("animationstart", event => {
      const element = event.target;
      if (!(element instanceof HTMLElement) || !element.matches(".fl-modal, .fl-toast")) return;
      const css = getComputedStyle(element);
      events.push({ component: element.className, state: element.dataset["state"], duration: css.animationDuration, easing: css.animationTimingFunction });
    });
  });
  for (const component of ["modal", "toast"]) {
    await page.getByRole("button", { name: component === "modal" ? "Open modal" : "Show warning", exact: true }).click();
    await expect(page.locator(`.fl-${component}`)).toBeVisible();
    await page.getByRole("button", { name: component === "modal" ? "Cancel" : "Dismiss notification", exact: true }).click();
    await expect(page.locator(`.fl-${component}`)).not.toBeAttached();
  }
  const motion = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const duration = css.getPropertyValue("--motion-base").trim();
    const timing = document.createElement("div").style;
    timing.animationTimingFunction = css.getPropertyValue("--ease-enter").trim();
    const enter = timing.animationTimingFunction;
    timing.animationTimingFunction = css.getPropertyValue("--ease-exit").trim();
    return { events: (window as unknown as { uiMotionEvents: { component: string; state: string; duration: string; easing: string }[] }).uiMotionEvents, duration: `${duration.endsWith("ms") ? parseFloat(duration) / 1000 : parseFloat(duration)}s`, enter, exit: timing.animationTimingFunction };
  });
  for (const component of ["fl-modal", "fl-toast"]) {
    for (const state of ["open", "closed"]) expect(motion.events).toContainEqual({ component, state, duration: motion.duration, easing: state === "open" ? motion.enter : motion.exit });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const component of ["modal", "toast"]) {
    await page.getByRole("button", { name: component === "modal" ? "Open modal" : "Show warning", exact: true }).click();
    await expect(page.locator(`.fl-${component}`)).toHaveCSS("animation-name", "none");
    await page.getByRole("button", { name: component === "modal" ? "Cancel" : "Dismiss notification", exact: true }).click();
    await expect(page.locator(`.fl-${component}`)).not.toBeAttached();
  }
});

test("shared controls match DESIGN geometry and the canonical Stitch header and hover states", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const tokens = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const number = (name: string) => parseFloat(css.getPropertyValue(name));
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--color-primary-subtle)";
    document.body.append(probe);
    const ghostHover = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { sm: number("--spacing-control-sm"), md: number("--spacing-control-md"), lg: number("--spacing-control-lg"), topBar: number("--spacing-top-bar-height"), padding: number("--spacing-space-4"), ghostPadding: number("--spacing-space-3"), largePadding: number("--spacing-space-5"), ghostHover };
  });
  for (const [name, height, padding] of [["Compact button", tokens.sm, tokens.ghostPadding], ["View Evidence", tokens.md, tokens.padding], ["Field button", tokens.lg, tokens.largePadding]] as const) {
    const button = page.getByRole("button", { name, exact: true });
    expect((await button.boundingBox())?.height).toBe(height);
    expect(await button.evaluate(element => parseFloat(getComputedStyle(element).paddingInlineStart))).toBe(padding);
  }
  const ghost = page.getByRole("button", { name: "Inspect sources", exact: true });
  await ghost.hover();
  await expect(ghost).toHaveCSS("background-color", tokens.ghostHover);
  expect(await ghost.evaluate(element => parseFloat(getComputedStyle(element).paddingInlineStart))).toBe(tokens.ghostPadding);
  expect((await page.locator(".fl-top-bar").boundingBox())?.height).toBe(tokens.topBar);
  await expect(page.getByRole("link", { name: "FieldLoop-v2", exact: true })).toBeVisible();
  await expect(page.getByText("Powered by Kaotor Technology", { exact: true })).toBeVisible();
  const thaiButton = await page.getByRole("button", { name: "Compact button", exact: true }).evaluate(element => {
    element.setAttribute("lang", "th");
    const css = getComputedStyle(element);
    return { size: parseFloat(css.fontSize), leading: parseFloat(css.lineHeight) / parseFloat(css.fontSize) };
  });
  expect(thaiButton.size).toBeGreaterThanOrEqual(13);
  expect(thaiButton.leading).toBeGreaterThanOrEqual(1.5);
});

test("Health markers use distinct triangle cross and hatched-square anchors in both themes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const degraded = page.getByRole("button", { name: "degraded Barrier marker", exact: true });
  const failed = page.getByRole("button", { name: "failed Barrier marker", exact: true });
  const unverified = page.getByRole("button", { name: "unverified Barrier marker", exact: true });
  await expect(degraded.locator("svg polygon")).toHaveCount(1);
  await expect(failed.locator("svg > path")).toHaveCount(1);
  await expect(unverified.locator("svg pattern")).toHaveCount(1);
  await expect(page.locator(".fl-map-marker svg circle")).toHaveCount(0);
  for (const marker of [degraded, failed, unverified]) {
    expect((await marker.boundingBox())?.width).toBeGreaterThanOrEqual(44);
    expect((await marker.locator("svg").boundingBox())?.width).toBe(24);
  }
  const lightFills = await page.locator(".fl-map-marker:not(:disabled) svg").evaluateAll(elements => elements.map(element => getComputedStyle(element).fill));
  const markers = page.locator(".preview-row").filter({ has: failed });
  await markers.screenshot({ path: "e2e/evidence/ui-kit-markers-light.png" });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  expect(await page.locator(".fl-map-marker:not(:disabled) svg").evaluateAll(elements => elements.map(element => getComputedStyle(element).fill))).toEqual(lightFills);
  expect(await failed.locator("span").evaluate(element => getComputedStyle(element, "::after").animationName)).toBe("none");
  await markers.screenshot({ path: "e2e/evidence/ui-kit-markers-dark.png" });
});

test("menus and tooltips use fast motion and respect reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const trigger of [page.getByRole("combobox", { name: "Evidence type", exact: true }), page.getByRole("button", { name: "Source", exact: true }), page.getByRole("button", { name: "Sources", exact: true })]) {
    await trigger.click();
    await expect(page.locator(".fl-select-menu")).toHaveCSS("animation-duration", "0.15s");
    await expect(page.locator(".fl-select-menu")).toHaveCSS("animation-timing-function", "cubic-bezier(0.2, 0, 0, 1)");
    await page.keyboard.press("Escape");
  }
  const railLink = page.getByRole("navigation", { name: "Component groups", exact: true }).getByRole("link", { name: "Controls", exact: true });
  await railLink.hover();
  await expect(page.locator(".fl-tooltip")).toBeVisible();
  await expect(page.locator(".fl-tooltip")).toHaveCSS("animation-duration", "0.15s");
  await expect(page.locator(".fl-tooltip")).toHaveCSS("animation-timing-function", "cubic-bezier(0.2, 0, 0, 1)");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".fl-tooltip")).toHaveCSS("animation-name", "none");
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Evidence type", exact: true }).click();
  await expect(page.locator(".fl-select-menu")).toHaveCSS("animation-name", "none");
});

test("Failed marker boundaries exceed three-to-one contrast on system and explicit dark surfaces", async ({ page }) => {
  function luminance(color: string) {
    const values = color.match(/[\d.]+/g)?.slice(0, 3);
    if (!values || values.length !== 3) throw new Error(`Unsupported colour: ${color}`);
    const [red = 0, green = 0, blue = 0] = values.map(value => {
      const channel = Number(value) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  for (const explicit of [false, true]) {
    if (explicit) await page.getByRole("button", { name: "Night shift", exact: true }).click();
    const colours = await page.getByRole("button", { name: "failed Barrier marker", exact: true }).evaluate(element => {
      const shape = element.querySelector("svg");
      const card = element.closest(".fl-card");
      if (!shape || !card) throw new Error("Missing marker or surface fixture");
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--color-dark-surface-raised)";
      document.body.append(probe);
      const raised = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { outline: getComputedStyle(shape).stroke, surface: getComputedStyle(card).backgroundColor, raised };
    });
    for (const background of [colours.surface, colours.raised]) {
      const outline = luminance(colours.outline);
      const surface = luminance(background);
      expect((Math.max(outline, surface) + 0.05) / (Math.min(outline, surface) + 0.05)).toBeGreaterThanOrEqual(3);
    }
  }
});

test("disabling an open selection closes it and preserves the value until editing resumes", async ({ page }) => {
  for (const label of ["Evidence type", "Source", "Sources"]) {
    const trigger = page.getByRole(label === "Evidence type" ? "combobox" : "button", { name: label, exact: true, includeHidden: true });
    const original = await trigger.textContent();
    await trigger.click();
    await expect(page.locator(".fl-select-menu")).toBeVisible();
    // A host state update can arrive while a portal is open (for example a save starts).
    await page.getByRole("button", { name: "Toggle selection editing", includeHidden: true }).evaluate(button => (button as HTMLButtonElement).click());
    await expect(trigger).toBeDisabled();
    await expect(page.locator(".fl-select-menu")).not.toBeAttached();
    await expect(trigger).toHaveText(original ?? "");
    await page.getByRole("button", { name: "Toggle selection editing" }).click();
    await trigger.click();
    if (label === "Evidence type") {
      await page.getByRole("option", { name: "Barrier", exact: true }).click();
    } else if (label === "Source") {
      await page.getByRole("option", { name: "Rain", exact: true }).click();
    } else {
      await page.getByRole("checkbox", { name: "Rain", exact: true }).check();
      await page.keyboard.press("Escape");
    }
    await expect(trigger).toHaveText(label === "Evidence type" ? /Barrier/ : /Rain/);
  }
});

test("multi-selection rows distinguish selected and disabled states in both themes", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    const checkbox = page.getByRole("checkbox", { name: "Rain", exact: true });
    await checkbox.check();
    const selected = checkbox.locator("..");
    const disabled = page.getByRole("checkbox", { name: "Archived", exact: true }).locator("..");
    const palette = await page.evaluate(() => {
      const probe = document.createElement("span"); document.body.append(probe);
      const colour = (variable: string) => { probe.style.backgroundColor = `var(${variable})`; return getComputedStyle(probe).backgroundColor; };
      const result = { selected: colour("--fl-selected"), primary: colour("--fl-primary"), disabled: colour("--fl-disabled"), disabledInk: colour("--fl-disabled-ink") };
      probe.remove(); return result;
    });
    await expect(selected).toHaveCSS("background-color", palette.selected);
    await expect(selected).toHaveCSS("color", palette.primary);
    await disabled.hover();
    await expect(disabled).toHaveCSS("cursor", "not-allowed");
    await expect(disabled).toHaveCSS("background-color", palette.disabled);
    await expect(disabled).toHaveCSS("color", palette.disabledInk);
    await expect(page.getByRole("checkbox", { name: "Archived", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
  }
});

test("Thai select scroll controls expose localized names", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 300 });
  await page.getByRole("combobox", { name: "ตัวเลือกแบบเลื่อน", exact: true }).click();
  await expect(page.locator('[aria-label="เลื่อนตัวเลือกลง"]')).toBeVisible();
  await expect(page.locator('[aria-label="Scroll options down"]')).toHaveCount(0);
  await page.getByRole("option", { name: "ตัวเลือกหนึ่ง", exact: true }).press("End");
  await expect(page.locator('[aria-label="เลื่อนตัวเลือกขึ้น"]')).toBeVisible();
  await expect(page.locator(".fl-select-menu")).toHaveAttribute("lang", "th");
});
