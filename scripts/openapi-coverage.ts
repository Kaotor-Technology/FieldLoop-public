type RegisteredRoute = { method: string | readonly string[]; url: string };

type OpenApiInventory = { paths: Record<string, Record<string, unknown>> };
const normalize = (path: string) => path.replace(/^\/api(?=\/v1\/)/, "").replace(/\/:[A-Za-z][A-Za-z0-9_]*(?:\([^/]*\))?/g, "/{}").replace(/::/g, ":").replace(/\{[^}]+\}/g, "{}");

// Observe actual registered versioned routes, including encapsulated plugins. Probe,
// auth and static-document paths are not versioned demo API operations. Fastify
// adds HEAD automatically to GET; inventory harnesses disable that convenience
// so explicit HEAD registrations still require their own contract.
export function undocumentedRoutes(routes: readonly RegisteredRoute[], spec: OpenApiInventory, prefix = "/api/v1/"): string[] {
  const documented = new Set(Object.entries(spec.paths).flatMap(([path, operations]) =>
    Object.keys(operations).map(method => `${method.toUpperCase()} ${normalize(path)}`)));
  return [...new Set(routes.filter(route => route.url.startsWith(prefix)).flatMap(route =>
    (typeof route.method === "string" ? [route.method] : route.method)
      .map(method => `${method.toUpperCase()} ${normalize(route.url)}`)
      .filter(operation => !documented.has(operation))))].sort();
}
