import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { applyRiskRecalculatedEvent } from "../src/risk-events";

it("invalidates the affected Bowtie queries and map Asset risk layer", () => {
  const client = new QueryClient();
  const bowtieId = "50000000-0000-4000-8000-000000000001";
  client.setQueryData(["bowtie", bowtieId, "risk"], { version: 1 });
  client.setQueryData(["bowtie", bowtieId, "risk", "explain"], { version: 1 });
  client.setQueryData(["bowtie", "another-bowtie", "risk"], { version: 1 });
  const firstAssetViewport = ["map-layer", "assets", [98, 17, 100, 19], 8] as const;
  const secondAssetViewport = ["map-layer", "assets", [98.5, 17.5, 100, 18.5], 10] as const;
  client.setQueryData(firstAssetViewport, { version: 1 });
  client.setQueryData(secondAssetViewport, { version: 1 });

  expect(applyRiskRecalculatedEvent(client, { bowtieId, snapshotId: "synthetic-snapshot" })).toBe(true);
  expect(client.getQueryState(["bowtie", bowtieId, "risk"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["bowtie", bowtieId, "risk", "explain"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["bowtie", "another-bowtie", "risk"])?.isInvalidated).toBe(false);
  expect(client.getQueryState(firstAssetViewport)?.isInvalidated).toBe(true);
  expect(client.getQueryState(secondAssetViewport)?.isInvalidated).toBe(true);
});

it("reports an event without a Bowtie ID as unhandled", () => {
  const client = new QueryClient();
  client.setQueryData(["bowtie", "synthetic-bowtie", "risk"], { version: 1 });

  expect(applyRiskRecalculatedEvent(client, { snapshotId: "synthetic-snapshot" })).toBe(false);
  expect(client.getQueryState(["bowtie", "synthetic-bowtie", "risk"])?.isInvalidated).toBe(false);
});
