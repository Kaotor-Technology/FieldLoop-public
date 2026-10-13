import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EmptyState, Skeleton } from "../src/Feedback.js";

it("keeps decorative loading blocks out of the accessibility tree", () => {
  expect(renderToStaticMarkup(<Skeleton />)).toContain('aria-hidden="true"');
});
it("explains empty data and preserves an actionable child", () => {
  const html = renderToStaticMarkup(<EmptyState title="No Evidence" description="Upload a report." action={<button>Upload Evidence</button>} />);
  expect(html).toContain("<h3>No Evidence</h3>");
  expect(html).toContain("Upload a report.");
  expect(html).toContain("Upload Evidence");
});
