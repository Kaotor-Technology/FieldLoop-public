import { describe, expect, it } from "vitest";
import { GoogleCloudBlobStore } from "../src/google-cloud-blob-store.js";

describe("GoogleCloudBlobStore", () => {
  it("uses create-only writes and verifies downloaded bytes before returning a URI", async () => {
    const writes: unknown[] = [];
    const store = new GoogleCloudBlobStore({ bucket: () => ({ file: () => ({
      save: async (_data, options) => { writes.push(options); },
      download: async () => [Buffer.from("source")],
    }) }) }, "fixture-docs");
    expect(await store.put("legal/digest/document.txt", Buffer.from("source"), "text/plain"))
      .toBe("gs://fixture-docs/legal/digest/document.txt");
    expect(writes).toEqual([expect.objectContaining({ preconditionOpts: { ifGenerationMatch: 0 } })]);
  });

  it("rejects an existing object with different bytes", async () => {
    const store = new GoogleCloudBlobStore({ bucket: () => ({ file: () => ({
      save: async () => { throw { code: 412 }; },
      download: async () => [Buffer.from("different")],
    }) }) }, "fixture-docs");
    await expect(store.put("legal/document.txt", Buffer.from("source"), "text/plain"))
      .rejects.toThrow(/does not match/);
  });

  it("propagates permission and network failures", async () => {
    const store = new GoogleCloudBlobStore({ bucket: () => ({ file: () => ({
      save: async () => { throw new Error("permission denied"); },
      download: async () => [Buffer.alloc(0)],
    }) }) }, "fixture-docs");
    await expect(store.put("legal/document.txt", Buffer.from("source"), "text/plain"))
      .rejects.toThrow("permission denied");
  });
});
