import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const REFERENCE_FILES = {
  "index.html": "text/html; charset=utf-8",
  "openapi.yaml": "application/yaml; charset=utf-8",
  "openapi.json": "application/json; charset=utf-8",
  "reference.css": "text/css; charset=utf-8",
  "reference.js": "text/javascript; charset=utf-8",
  "ibm-plex-mono-latin-400-normal.woff2": "font/woff2",
  "ibm-plex-sans-thai-thai-400-normal.woff2": "font/woff2",
  "ibm-plex-sans-thai-latin-400-normal.woff2": "font/woff2",
} as const;

// Exact routes under /api inherit the BFF session check; no public static wildcard.
export async function registerReference(app: FastifyInstance, root: string): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url;
    if (route === "/api/reference" || route?.startsWith("/api/reference/")) {
      reply.header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .header("x-robots-tag", "noindex, nofollow")
        .header("referrer-policy", "no-referrer")
        .header("content-security-policy", "default-src 'none'; style-src 'self'; script-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    }
  });
  for (const [file, contentType] of Object.entries(REFERENCE_FILES)) {
    // Missing build output is a startup failure, never a public fallback or stale shell.
    const content = await readFile(join(root, file));
    const urls = file === "index.html" ? ["/api/reference", "/api/reference/", "/api/reference/index.html"] : [`/api/reference/${file}`];
    for (const url of urls) app.get(url, { exposeHeadRoute: false }, async (_request, reply) => reply.type(contentType).send(content));
  }
}
