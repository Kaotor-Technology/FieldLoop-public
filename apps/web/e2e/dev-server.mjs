// Run the same BFF/browser cases against Vite's development configuration.
import { createServer } from "vite";
import { join } from "node:path";

process.env["FIELDLOOP_BROWSER_BASE_URL"] = "https://localhost:5173";
const fixture = await import("../../api/test/browser-server.mjs");
process.env["FIELDLOOP_DEV_API_TARGET"] = "https://localhost:4173";
process.env["FIELDLOOP_DEV_API_INSECURE"] = "true";
process.env["FIELDLOOP_DEV_TLS_CERT"] = join(fixture.directory, "cert.pem");
process.env["FIELDLOOP_DEV_TLS_KEY"] = join(fixture.directory, "key.pem");

const vite = await createServer({
  // Vite exits after its own SIGTERM handler; cleanup must be awaited inside it.
  plugins: [{ name: "scripted-bff-cleanup", closeBundle: fixture.closeBrowserServer }],
  server: {
    host: "localhost", port: 5173, strictPort: true,
    // Scripted IdP/test controls exist only in this local fixture.
    proxy: { "/test": { target: "https://localhost:4173", secure: false } },
  },
});
process.once("SIGINT", async () => { await vite.close(); });
await vite.listen();
