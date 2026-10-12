import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Navigate, RouterProvider } from "@tanstack/react-router";
import { MapEntry } from "./MapEntry";
import "./i18n";
import "@fontsource/ibm-plex-sans-thai/400.css";
import "@fontsource/ibm-plex-sans-thai/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fieldloop/ui/tokens.css";
import "./styles.css";

const queryClient = new QueryClient();
const rootRoute = createRootRoute({ component: App });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <Navigate to="/map" replace /> });
const mapRoute = createRoute({ getParentRoute: () => rootRoute, path: "/map", component: MapEntry });
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, mapRoute]) });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
