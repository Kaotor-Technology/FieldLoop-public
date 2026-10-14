import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import "./i18n";
import { BowtieCanvas } from "./BowtieCanvas";
import { listBowties } from "./bowtie-data";

describe("Bowtie canvas", () => {
  it.each(listBowties())("renders Bowtie $code as a read-only three-column view", (bowtie) => {
    const markup = renderToStaticMarkup(<BowtieCanvas bowtie={bowtie} onBack={() => undefined} />);

    expect(markup).toContain('aria-label="Bowtie canvas"');
    expect(markup).toContain('id="main-content"');
    expect(markup.match(/class="bowtie-column/g)).toHaveLength(3);
    expect(markup).toContain("Threats");
    expect(markup).toContain("Preventive Barriers");
    expect(markup).toContain("Mitigative Barriers");
    expect(markup).toContain("Top Event");
    expect(markup).toContain("Back to map");
    if (bowtie.code === "A") expect(markup).toContain('class="mono">DL-01</span>');
    expect(markup).toContain('class="bowtie-text-equivalent"');
    expect(markup).not.toContain("Edit Bowtie");
  });

  it("renders Health badges, Degradation Factors, Validation Triad and Independence Groups", () => {
    const bowtie = listBowties().find(({ code }) => code === "A");
    if (!bowtie) throw new Error("Bowtie A fixture is required");
    const markup = renderToStaticMarkup(<BowtieCanvas bowtie={bowtie} onBack={() => undefined} />);
    const renderedText = markup.replaceAll("&amp;", "&");
    const healthShapes = { healthy: "●", degraded: "▲", failed: "✖", unverified: "⬚" } as const;

    for (const threat of bowtie.threats) expect(renderedText).toContain(threat.name);
    for (const barrier of bowtie.barriers) {
      expect(renderedText).toContain(barrier.name);
      expect(markup).toContain(`data-health="${barrier.health}"`);
      expect(markup).toContain(`aria-hidden="true">${healthShapes[barrier.health]}</span>`);
      for (const pathName of barrier.pathNames) expect(renderedText).toContain(pathName);
      for (const factor of barrier.degradationFactors) expect(renderedText).toContain(factor.description);
    }
    expect(markup).toContain("Degradation Factors");
    expect(markup).toContain("Validation Triad");
    expect(markup).toContain("Independence Groups");
    expect(markup).toContain("Text equivalent of the Bowtie canvas");
    expect(markup).toContain("Domain:");
    expect(markup).toContain("Classification:");
    expect(markup).toContain("Type: Technical");
  });

  it("includes Independence Group barrier membership in the text equivalent", () => {
    const bowtie = listBowties().find(({ code }) => code === "C");
    if (!bowtie) throw new Error("Bowtie C fixture is required");
    const markup = renderToStaticMarkup(<BowtieCanvas bowtie={bowtie} onBack={() => undefined} />);

    expect(markup).toContain("Shared by Barriers:");
  });

  it("renders a shared Barrier only once", () => {
    const bowtie = listBowties().find(({ code }) => code === "A");
    if (!bowtie) throw new Error("Bowtie A fixture is required");
    const sharedBarrier = bowtie.barriers.find(({ pathNames }) => pathNames.length > 1);
    if (!sharedBarrier) throw new Error("Bowtie A needs at least one Barrier");
    const sharedBowtie = { ...bowtie, barriers: [...bowtie.barriers, sharedBarrier] };

    const markup = renderToStaticMarkup(<BowtieCanvas bowtie={sharedBowtie} onBack={() => undefined} />);
    const textEquivalentBarriers = markup.match(/<h3>Barriers<\/h3><ul>([\s\S]*?)<\/ul>/)?.[1] ?? "";

    expect(markup.match(/class="bowtie-barrier-card"/g) ?? []).toHaveLength(new Set(bowtie.barriers.map(({ id }) => id)).size);
    expect(textEquivalentBarriers.match(/<li>/g) ?? []).toHaveLength(new Set(bowtie.barriers.map(({ id }) => id)).size);
    for (const pathName of sharedBarrier.pathNames) expect(markup.replaceAll("&amp;", "&")).toContain(pathName);
  });
});
