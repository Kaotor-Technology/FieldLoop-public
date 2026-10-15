export type TranslationResource = { [key: string]: string | TranslationResource };
export function flattenResources(resource: TranslationResource, prefix?: string, result?: Record<string, string>): Record<string, string>;
export function validateResources(resources: Record<string, TranslationResource>, usedKeys?: string[]): string[];
export function translationKeys(source: string, filename?: string): string[];
