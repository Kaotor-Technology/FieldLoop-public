import { describe, expect, it, vi } from "vitest";
import { invalidateActionRequestQueries } from "./action-request-events";

describe("Action Request live event cache invalidation", () => {
  it("invalidates the matching Query cache record from an action_request.updated event", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const client = { invalidateQueries } as unknown as Parameters<typeof invalidateActionRequestQueries>[0];

    await invalidateActionRequestQueries(client, { actionRequestId: "synthetic-action-request" });

    expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["action-request", "synthetic-action-request"] });
  });

  it("invalidates all Action Request cache records when the event has no record identifier", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const client = { invalidateQueries } as unknown as Parameters<typeof invalidateActionRequestQueries>[0];

    await invalidateActionRequestQueries(client, { status: "approved" });

    expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["action-request"] });
  });
});
