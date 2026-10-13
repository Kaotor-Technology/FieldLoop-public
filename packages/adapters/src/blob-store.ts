export interface BlobStore {
  /** Store immutable content and return its private URI after verification. */
  put(name: string, content: Uint8Array, contentType: string): Promise<string>;
}
