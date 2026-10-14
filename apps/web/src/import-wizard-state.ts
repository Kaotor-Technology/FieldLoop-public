import { createStore } from "zustand/vanilla";
import { z } from "zod";
import type { components } from "@fieldloop/contracts";

export type ImportMapping = components["schemas"]["ImportMapping"];
type ImportPreview = components["schemas"]["ImportPreview"];
export const DEFAULT_IMPORT_MAPPING: ImportMapping = {
  assetId:"",toleranceMetres:50,nameField:"",descriptionField:"",categoryField:"folder",target:"facility",barrierId:null,
};
export const importMappingSchema = z.strictObject({
  assetId:z.uuid(), toleranceMetres:z.number().min(0).max(1000),
  nameField:z.string().max(200), descriptionField:z.string().max(200), categoryField:z.string().max(200),
  target:z.enum(["evidence","facility"]),barrierId:z.uuid().nullable(),
}).superRefine((mapping,context) => {
  if (mapping.target === "evidence" && mapping.barrierId === null) {
    context.addIssue({code:"custom",path:["barrierId"],message:"Evidence requires a Barrier"});
  }
});
export function defaultImportMapping(preview: ImportPreview | undefined): ImportMapping {
  if (preview?.mapping) return preview.mapping;
  const fields=new Set(preview?.points.flatMap(point=>Object.keys(point.attributes)) ?? []);
  return {...DEFAULT_IMPORT_MAPPING,nameField:fields.has("name") ? "name":"",descriptionField:fields.has("description") ? "description":""};
}
interface ImportWizardUiState {
  open:boolean;
  file:File | null;
  requestKey:string;
  setOpen:(open:boolean)=>void;
  setFile:(file:File | null)=>void;
}
export function createImportWizardUiState(open:boolean) {
  return createStore<ImportWizardUiState>()(set=>({
    open,file:null,requestKey:crypto.randomUUID(),
    setOpen:open=>set({open}),
    setFile:file=>set({file,requestKey:crypto.randomUUID()}),
  }));
}
