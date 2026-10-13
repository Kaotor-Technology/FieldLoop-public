import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../src/Button.js";
import { Input, Textarea } from "../src/Input.js";

describe("accessible controls", () => {
  it("keeps loading text and prevents repeat commands without default form submission", () => {
    const html = renderToStaticMarkup(<Button loading>Create Draft</Button>);
    expect(html).toContain('type="button"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Create Draft");
  });
  it("connects labels, error and existing descriptions without losing numeric typography", () => {
    const html = renderToStaticMarkup(<Input id="chainage" label="Chainage" type="number" error="Enter a Chainage" aria-describedby="units" />);
    expect(html).toContain('for="chainage"');
    expect(html).toContain('aria-describedby="units chainage-message"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="chainage-message"');
    expect(html).toContain("fl-mono");
  });
  it("labels multiline inputs and links helper text", () => {
    const html = renderToStaticMarkup(<Textarea id="reason" label="Reason" helper="Describe the Evidence" />);
    expect(html).toContain('for="reason"');
    expect(html).toContain('aria-describedby="reason-message"');
  });
});
