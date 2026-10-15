import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Navigate, RouterProvider } from "@tanstack/react-router";
import { MapEntry } from "./MapEntry";
import { BowtieCanvasPage } from "./BowtieCanvasPage";
import { AuditPage } from "./AuditPage";
import { AgentWorkspace } from "./AgentWorkspace";
import { DraftReviewPage } from "./DraftReviewPage";
import { usePreferences } from "./preferences";
import "./i18n";
import "@fontsource/ibm-plex-sans-thai/400.css";
import "@fontsource/ibm-plex-sans-thai/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fieldloop/ui/tokens.css";
import "@fieldloop/ui/styles.css";
import "./styles.css";

const queryClient = new QueryClient();
const rootRoute = createRootRoute({ component: App });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <Navigate to="/map" replace /> });
const mapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/map",
  validateSearch: (search: Record<string, unknown>) => search,
  component: MapEntry,
});
const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audit",
  validateSearch: (search: Record<string, unknown>) => search,
  component: AuditPage,
});
const draftsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/drafts",
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search["draftId"] === "string" ? { draftId: search["draftId"] } : {}),
  }),
  component: DraftReviewPage,
});
const bowtieRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bowties/$bowtieId",
  component: BowtieCanvasPage,
});
const legacyBowtieRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bowtie/$bowtieId",
  validateSearch: (search: Record<string, unknown>) => search,
  component: lazyRouteComponent(() => import("./BowtieEntry"), "BowtieEntry"),
});
const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agent",
  validateSearch: (search: Record<string, unknown>) => search,
  component: AgentWorkspace,
});
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, mapRoute, auditRoute, draftsRoute, bowtieRoute, legacyBowtieRoute, agentRoute]) });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
document.documentElement.dataset["theme"] = usePreferences.getState().nightShift ? "dark" : "light";
createRoot(root).render(<StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
