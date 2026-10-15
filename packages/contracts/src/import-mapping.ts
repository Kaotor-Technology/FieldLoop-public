import { z } from "zod";

export const importMappingSchema = z.strictObject({
  assetId: z.uuid(),
  toleranceMetres: z.number().min(0).max(1000),
  nameField: z.string().max(200),
  descriptionField: z.string().max(200),
  categoryField: z.string().max(200),
  target: z.enum(["evidence", "facility"]),
  barrierId: z.uuid().nullable(),
}).superRefine((mapping, context) => {
  if (mapping.target === "evidence" && mapping.barrierId === null) {
    context.addIssue({ code: "custom", path: ["barrierId"], message: "Evidence requires a Barrier" });
  }
});

export const importMappingRequestSchema = z.strictObject({
  version: z.number().int().min(1),
  mapping: importMappingSchema,
});

export type ImportMapping = z.infer<typeof importMappingSchema>;
