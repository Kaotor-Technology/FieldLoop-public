import { describe, expect, it } from "vitest";
import { mapReturnLocation } from "./BowtieEntry";

describe("Bowtie map return navigation", () => {
  it("keeps the map viewport search state when returning", () => {
    const search = { lat: "18.79258", lng: "99.54886", zoom: "8", heading: "0", tilt: "45" };
    expect(mapReturnLocation(search)).toEqual({ to: "/map", search });
  });
});
