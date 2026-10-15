import { createHash } from "node:crypto";
import type { ActionRequestCreate } from "@fieldloop/contracts";
import { ActionError } from "./action-policy.js";

// Authored Public exercise content, independent of classified packs, retrieval and model output.
// A revision requires code review; there is deliberately no substitution or free-text field.
const templateId = "district-z3-exercise-v1";
const message = "SIMULATION — District Z3 exercise warning. Follow the exercise response plan and instructions from the exercise Commander. This is a sandbox exercise, not an official alert.\n"
  + "SIMULATION — คำเตือนฝึกซ้อมเขต Z3 โปรดปฏิบัติตามแผนฝึกซ้อมและคำแนะนำของผู้บัญชาการฝึกซ้อม ข้อความนี้ใช้ในช่องทางทดสอบ ไม่ใช่ประกาศเตือนภัยจริง";
export function publicWarningAction(selection: unknown): ActionRequestCreate {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new ActionError(400, "invalid_public_warning_selection");
  const { templateId: id, channels, recipientRefs } = selection as Record<string, unknown>;
  if (Object.keys(selection).some(k => !["templateId", "channels", "recipientRefs"].includes(k)) || id !== templateId
    || !Array.isArray(channels) || !channels.length || channels.some(c => c !== "telegram" && c !== "discord")
    || new Set(channels).size !== channels.length || !Array.isArray(recipientRefs) || recipientRefs.length !== 1
    || recipientRefs[0] !== "sandbox:district-z3") throw new ActionError(400, "invalid_public_warning_selection");
  return { actionType: "emergency_communication", actionLevel: "l2", target: "stakeholders", simulated: true, classification: "PUBLIC",
    payload: { message, channels: [...channels], recipientRefs: [...recipientRefs],
      publicSource: { id: templateId, revision: 1, classification: "PUBLIC", sha256: createHash("sha256").update(message).digest("hex") } },
    rationale: "Authored Public SIMULATION template selected for sandbox delivery; no classified source content is used.",
    citations: [`public-warning:${templateId}`] };
}
