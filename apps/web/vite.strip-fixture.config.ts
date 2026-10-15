import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Local PUBLIC fixtures only; do not expose offline classified generators or DATA
// through Vite's workspace-wide /@fs resolver. This is NOT the production BFF.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", strictPort: true,
    fs: { deny: ["**/.env*", "**/*.{crt,pem}", "**/.git/**", fileURLToPath(new URL("../../data/", import.meta.url)) + "**", "**/db/seed/**", "**/raw-data/**", "**/*.kmz"] },
    headers: { "Cache-Control": "no-store" },
  },
});
