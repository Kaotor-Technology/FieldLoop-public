import { describe, expect, it } from "vitest";
import { getBowtie, listBowties } from "./bowtie-data";

describe("Bowtie viewer data", () => {
  it("provides the three synthetic Bowties named in FL-84", () => {
    expect(listBowties().map(({ code }) => code)).toEqual(["A", "C", "D"]);
    expect(listBowties().map(({ provenance }) => provenance)).toEqual(["SYNTHETIC", "SYNTHETIC", "SYNTHETIC"]);
  });

  it("binds each Bowtie's threats, Barriers, Health and consequences", () => {
    for (const bowtie of listBowties()) {
      expect(bowtie.hazard).not.toBe("");
      expect(bowtie.topEvent).not.toBe("");
      expect(bowtie.threats.length).toBeGreaterThan(0);
      expect(bowtie.consequences.length).toBeGreaterThan(0);
      expect(bowtie.barriers.some(({ side }) => side === "preventive")).toBe(true);
      expect(bowtie.barriers.some(({ side }) => side === "mitigative")).toBe(true);
      expect(bowtie.barriers.every(({ health }) => ["healthy", "degraded", "failed", "unverified"].includes(health))).toBe(true);
    }
  });

  it("retains A and D seed degradation, Validation Triad and Independence Group details", () => {
    const bowtieA = getBowtie("dl-01-bowtie-a");
    const bowtieD = getBowtie("bangkok-bowtie-d");
    expect(bowtieA?.barriers.some(({ degradationFactors }) => degradationFactors.length > 0)).toBe(true);
    expect(bowtieA?.barriers.some(({ triad }) => Object.keys(triad).length === 3)).toBe(true);
    expect(bowtieA?.independenceGroups.length).toBeGreaterThan(0);
    expect(bowtieD?.barriers.some(({ degradationFactors }) => degradationFactors.length > 0)).toBe(true);
    expect(bowtieD?.barriers.some(({ triad }) => Object.keys(triad).length === 3)).toBe(true);
    expect(bowtieD?.independenceGroups.length).toBeGreaterThan(0);
  });

  it("keeps Bowtie C Unverified where no operational Evidence is available", () => {
    const bowtieC = getBowtie("uc-1-bowtie-c");
    expect(bowtieC?.barriers.length).toBeGreaterThan(0);
    expect(bowtieC?.barriers.every(({ health }) => health === "unverified")).toBe(true);
    expect(bowtieC?.barriers.every(({ triad }) => Object.keys(triad).length === 3)).toBe(true);
    expect(bowtieC?.independenceGroups).toHaveLength(1);
  });

  it("does not resolve unknown Bowtie ids", () => {
    expect(getBowtie("unknown")).toBeUndefined();
  });
});
