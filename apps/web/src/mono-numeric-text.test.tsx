import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { monoNumericText } from "./mono-numeric-text";

it("renders numeric and identifier parts in the mono token while preserving reading text", () => {
  const markup = renderToStaticMarkup(<>{monoNumericText("KP 045+200 at Ban Klang, FL-92 (-13.75, 100.5)")}</>);

  expect(markup).toContain("KP ");
  expect(markup).toContain('<span class="mono">045</span>+<span class="mono">200</span>');
  expect(markup).toContain('<span class="mono">FL-92</span>');
  expect(markup).toContain("(-<span class=\"mono\">13.75</span>, <span class=\"mono\">100.5</span>)");
});
