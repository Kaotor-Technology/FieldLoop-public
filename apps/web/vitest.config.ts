import { defineConfig, mergeConfig } from "vitest/config";
import base from "@fieldloop/config/vitest";

export default mergeConfig(base, defineConfig({ test: { exclude: ["**/e2e/**", "**/node_modules/**"] } }));
