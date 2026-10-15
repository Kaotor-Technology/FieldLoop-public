// The assistant is an internal FastAPI service, not the browser cookie API.
export default function assistantContract(document) {
  const findings = [];
  const report = (message, path) => findings.push({ message, path });
  const scheme = document.components?.securitySchemes?.internalUserToken;
  if (scheme?.type !== "apiKey" || scheme.in !== "header" || scheme.name !== "x-fieldloop-internal-user-token") {
    report("Require the signed internal user token header.", ["components", "securitySchemes", "internalUserToken"]);
  }
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!path.startsWith("/assistant/v1/")) report("Assistant paths stay under /assistant/v1/.", ["paths", path]);
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options", "trace"]) {
      const operation = item[method];
      if (!operation) continue;
      const security = operation.security ?? document.security;
      if (!Array.isArray(security) || security.length !== 1 || Object.keys(security[0]).length !== 1
        || !Array.isArray(security[0].internalUserToken) || security[0].internalUserToken.length !== 0) {
        report("Every operation requires internal user identity without public alternatives.", ["paths", path, method, "security"]);
      }
      if (!operation.responses?.["422"]?.content?.["application/json"]?.schema) {
        report("Document the native FastAPI JSON validation response.", ["paths", path, method, "responses", "422"]);
      }
    }
  }
  return findings;
}
