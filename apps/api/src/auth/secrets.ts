export interface SecretReader {
  read(secretId: string, version?: string): Promise<string>;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
