import { defineConfig, mergeConfig } from "vitest/config";
import preset from "@fieldloop/config/vitest";

export default mergeConfig(preset, defineConfig({ test: { include: ["scripts/**/*.test.ts"] } }));
