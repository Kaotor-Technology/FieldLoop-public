const APPS = ["api", "guardrail", "signal-worker", "assistant", "simulator"] as const;
export type ReleaseApp = typeof APPS[number];

// Changed files span the last successful deployment, including earlier unreleased commits.
export function appNeedsRelease(app: ReleaseApp, changedFiles: string[], affectedPackages: string[]): boolean {
  if (changedFiles.some(path => [".dockerignore", "scripts/release-selection.ts", "scripts/select-release-apps.mjs"].includes(path))) return true;
  if (["assistant", "simulator"].includes(app)) {
    return changedFiles.some(path => path.startsWith(`apps/${app}/`) || path.startsWith("py/") || ["uv.lock", "pyproject.toml"].includes(path));
  }
  if (changedFiles.some(path => ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".nvmrc", "turbo.json"].includes(path))) return true;
  // Dockerfiles are not package build inputs, and the API embeds the web application.
  return changedFiles.some(path => path.startsWith(`apps/${app}/`)) || affectedPackages.includes(`@fieldloop/${app}`) ||
    (app === "api" && (affectedPackages.includes("@fieldloop/web") || changedFiles.some(path => path.startsWith("apps/web/"))));
}
export { APPS };
