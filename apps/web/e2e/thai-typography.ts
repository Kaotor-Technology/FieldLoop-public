import { expect, type Page } from "@playwright/test";

export async function expectThaiTypography(page: Page) {
  const issues = await page.locator("body").evaluate((body) => {
    const hasThaiText = (element: Element) => Array.from(element.childNodes).some((node) =>
      node.nodeType === Node.TEXT_NODE && /[\u0e00-\u0e7f]/u.test(node.textContent ?? ""));
    return Array.from(body.querySelectorAll("*")).filter(hasThaiText).flatMap((element) => {
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const computedLineHeight = Number.parseFloat(style.lineHeight);
      const lineHeight = computedLineHeight / fontSize;
      const letterSpacing = style.letterSpacing;
      const overflowWrap = style.overflowWrap;
      const wordBreak = style.wordBreak;
      return !Number.isFinite(fontSize) || fontSize < 13
        || !Number.isFinite(computedLineHeight) || lineHeight < 1.5
        || (letterSpacing !== "normal" && Number.parseFloat(letterSpacing) !== 0)
        || overflowWrap === "anywhere" || overflowWrap === "break-word" || wordBreak === "break-all"
        ? [{
          element: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).replaceAll(" ", ".")}` : ""}`,
          text: element.textContent?.trim().slice(0, 40), fontSize, lineHeight, letterSpacing, overflowWrap, wordBreak,
        }]
        : [];
    });
  });
  expect(issues).toEqual([]);
}
