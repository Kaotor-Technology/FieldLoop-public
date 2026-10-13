import { expect, it } from "vitest";
import { createCloudRunFetch } from "../src/cloud-run-fetch.js";

it("keeps invoker identity server-side and refuses redirects and another origin", async () => {
  const auth = { getIdTokenClient: async () => ({ getRequestHeaders: async () => new Headers({ authorization: "Bearer fixture-invoker-identity" }) }) };
  const invoke = createCloudRunFetch("https://simulator.example.test", auth, async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    expect(request.headers.get("authorization")).toBe("Bearer fixture-invoker-identity");
    expect(request.redirect).toBe("error");
    return Response.json({ status: "fixture" });
  });
  await invoke(new Request("https://simulator.example.test/v1/scenarios"));
  await expect(invoke(new Request("https://another.example.test/v1/scenarios"))).rejects.toThrow("configured origin");
});
