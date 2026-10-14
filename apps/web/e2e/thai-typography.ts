import { expect, type Page } from "@playwright/test";

export async function expectThaiTypography(page: Page) {
  const issues = await page.locator("body").evaluate((body) => {
    const hasThaiText = (element: Element) => Array.from(element.childNodes).some((node) =>
      node.nodeType === Node.TEXT_NODE && /[\u0e00-\u0e7f]/u.test(node.textContent ?? ""));
    return Array.from(body.querySelectorAll("*")).filter(hasThaiText).flatMap((element) => {
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const lineHeight = Number.parseFloat(style.lineHeight) / fontSize;
      const letterSpacing = style.letterSpacing;
      return fontSize < 13 || lineHeight < 1.5 || (letterSpacing !== "normal" && Number.parseFloat(letterSpacing) !== 0)
        ? [{
          element: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).replaceAll(" ", ".")}` : ""}`,
          text: element.textContent?.trim().slice(0, 40), fontSize, lineHeight, letterSpacing,
        }]
        : [];
    });
  });
  expect(issues).toEqual([]);
}
