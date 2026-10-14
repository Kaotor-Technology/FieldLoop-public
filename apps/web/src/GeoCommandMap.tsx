import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { GeoJsonLayer, IconLayer, ScatterplotLayer } from "@deck.gl/layers";
import { FillStyleExtension, PathStyleExtension } from "@deck.gl/extensions";
import type { FillStyleExtensionProps, PathStyleExtensionProps } from "@deck.gl/extensions";
import { GoogleMapsOverlay } from "@deck.gl/google-maps";
import type { MapFeature, MapFeatureCollection, MapLayerName, MapViewport } from "@fieldloop/map";
import type { BarrierHealth } from "@fieldloop/ui";
import { HealthProposalReview } from "./HealthProposalReview";
import { decideHealthProposal, getHealthProposalPage, healthProposalsQueryKey } from "./health-proposals";
import { useCurrentSession } from "./SessionGate";
import { getMapConfig, getMapLayer } from "./map-api";
import {
  barrierMarkerStatus,
  countVisibleBarrierAlerts,
  filterFeaturesByDomain,
  riskBandVisualStyle,
  searchVisibleFeatures,
  selectBarrierMarkerFeatures,
  selectVisibleFeatures,
  summarizeVisibleFeatures,
} from "./map-view";

const LAYERS: MapLayerName[] = ["assets", "barriers", "consequences"];
const DEFAULT_VIEW: MapViewport = { latitude: 13.775, longitude: 100.58, zoom: 13, heading: 0, tilt: 45 };
const PIPELINE_VIEW: MapViewport = { latitude: 18.79258, longitude: 99.54886, zoom: 8, heading: 0, tilt: 45 };
const FLOOD_VIEW: MapViewport = { latitude: 13.775, longitude: 100.58, zoom: 13, heading: 0, tilt: 45 };
const SYMBOLS: Record<string, string> = { degraded: "▲", failed: "✖", unverified: "⬚" };
const RISK_BANDS = ["intolerable", "alarp", "acceptable"] as const;
const BARRIER_HEALTH_STATES = ["healthy", "degraded", "failed", "unverified"] as const;
const BARRIER_ICON_ATLAS = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="32" viewBox="0 0 96 32"><defs><mask id="hatch"><rect x="68" y="3" width="24" height="26" fill="white"/><path d="m67 11 9-9m-4 19L89 4m-8 25 13-13" stroke="black" stroke-width="4"/></mask></defs><path d="M16 2 30 29H2z" fill="white"/><path d="m39 7 18 18m0-18L39 25" stroke="white" stroke-width="4"/><rect x="68" y="3" width="24" height="26" fill="white" mask="url(#hatch)"/><path d="M68 3h24v26H68z" fill="none" stroke="white" stroke-width="2"/></svg>')}`;
const BARRIER_ICON_MAPPING = {
  degraded: { x: 0, y: 0, width: 32, height: 32, mask: true },
  failed: { x: 32, y: 0, width: 32, height: 32, mask: true },
  unverified: { x: 64, y: 0, width: 32, height: 32, mask: true },
};
let configuredMapsApiKey: string | undefined;

interface ViewportBounds {
  bbox: readonly [number, number, number, number];
  zoom: number;
}

export function GeoCommandMap() {
  const { t } = useTranslation();
  const search = useSearch({ from: "/map" });
  const navigate = useNavigate({ from: "/map" });
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const overlay = useRef<GoogleMapsOverlay | null>(null);
  const baseLayers = useRef<NonNullable<ConstructorParameters<typeof GoogleMapsOverlay>[0]["layers"]>>([]);
  const pulseOpacity = useRef(0.2);
  const [viewport, setViewport] = useState<MapViewport>(() => readViewportFromSearch(search));
  const initialViewport = useRef(viewport);
  const [bounds, setBounds] = useState<ViewportBounds | null>(null);
  const [activeLayers, setActiveLayers] = useState<MapLayerName[]>(LAYERS);
  const [domain, setDomain] = useState<"all" | "pipeline-integrity" | "flood-water">("all");
  const [selectedFeature, setSelectedFeature] = useState<MapFeature | null>(null);
  const [query, setQuery] = useState("");
  const [mapLoadFailed, setMapLoadFailed] = useState(false);
  const [mapRetry, setMapRetry] = useState(0);
  const mapConfig = useQuery({ queryKey: ["map-config"], queryFn: ({ signal }) => getMapConfig(signal), retry: 1 });
  const visibleLayers = useQueries({
    queries: LAYERS.map((layer) => ({
      queryKey: ["map-layer", layer, bounds?.bbox, bounds?.zoom],
      queryFn: ({ signal }: { signal: AbortSignal }) => getMapLayer({
        layer,
        bbox: bounds?.bbox ?? [0, 0, 0, 0],
        zoom: bounds?.zoom ?? 0,
        signal,
      }),
      enabled: Boolean(bounds) && activeLayers.includes(layer),
      staleTime: 30_000,
      retry: 1,
    })),
  });

  useEffect(() => {
    const apiKey = mapConfig.data?.mapsApiKey;
    if (!apiKey || !mapElement.current || map.current) return;
    let mounted = true;
    let idleListener: google.maps.MapsEventListener | undefined;
    if (!configuredMapsApiKey) {
      setOptions({ key: apiKey, v: "weekly" });
      configuredMapsApiKey = apiKey;
    }
    void importLibrary("maps").then((library) => {
      if (!mounted || !mapElement.current) return;
      const mapInstance = new library.Map(mapElement.current, {
        center: { lat: initialViewport.current.latitude, lng: initialViewport.current.longitude },
        zoom: initialViewport.current.zoom,
        heading: initialViewport.current.heading,
        tilt: initialViewport.current.tilt,
        clickableIcons: false,
        fullscreenControl: false,
        mapTypeControl: false,
        streetViewControl: false,
        zoomControl: false,
        gestureHandling: "greedy",
      });
      map.current = mapInstance;
      overlay.current = new GoogleMapsOverlay({ layers: [] });
      overlay.current.setMap(mapInstance);
      const refreshViewport = () => {
        const mapBounds = mapInstance.getBounds();
        const center = mapInstance.getCenter();
        const zoom = mapInstance.getZoom();
        if (!mapBounds || !center || zoom === undefined) return;
        const southWest = mapBounds.getSouthWest();
        const northEast = mapBounds.getNorthEast();
        const nextViewport: MapViewport = {
          latitude: round(center.lat(), 5),
          longitude: round(center.lng(), 5),
          zoom: Math.round(zoom),
          heading: Math.round(mapInstance.getHeading() ?? 0),
          tilt: Math.round(mapInstance.getTilt() ?? 0),
        };
        setViewport(nextViewport);
        setBounds({
          bbox: [southWest.lng(), southWest.lat(), northEast.lng(), northEast.lat()],
          zoom: Math.round(zoom),
        });
        void navigate({
          search: (previous) => ({
            ...previous,
            lat: nextViewport.latitude.toFixed(5),
            lng: nextViewport.longitude.toFixed(5),
            zoom: String(nextViewport.zoom),
            heading: String(nextViewport.heading),
            tilt: String(nextViewport.tilt),
          }),
          replace: true,
        });
      };
      idleListener = mapInstance.addListener("idle", refreshViewport);
      refreshViewport();
    }).catch(() => {
      if (mounted) setMapLoadFailed(true);
    });
    return () => {
      mounted = false;
      idleListener?.remove();
      overlay.current?.setMap(null);
      overlay.current?.finalize();
      overlay.current = null;
      map.current = null;
    };
  }, [mapConfig.data?.mapsApiKey, mapRetry]);

  const collections = useMemo(() => {
    const byLayer = new Map<MapLayerName, MapFeatureCollection>();
    LAYERS.forEach((layer, index) => {
      const data = visibleLayers[index]?.data;
      if (data) byLayer.set(layer, data);
    });
    return byLayer;
  }, [visibleLayers]);
  const visibleFeatures = useMemo(() => selectVisibleFeatures(LAYERS.map((layer, index) => ({
    layer, features: visibleLayers[index]?.data?.features ?? [],
  })), activeLayers, domain),
  [activeLayers, domain, visibleLayers]);
  const features = useMemo(() => searchVisibleFeatures(visibleFeatures, query),
  [visibleFeatures, query]);
  const layerError = visibleLayers.some((result, index) => {
    const layer = LAYERS[index];
    return layer !== undefined && activeLayers.includes(layer) && result.isError;
  });
  const featureCounts = useMemo(() => countVisibleBarrierAlerts(visibleFeatures), [visibleFeatures]);
  const contextSummary = useMemo(() => summarizeVisibleFeatures(visibleFeatures), [visibleFeatures]);

  useEffect(() => {
    if (!overlay.current) return;
    const lineWidth = designTokenPixels("--spacing-indicator-width");
    const assetPointRadius = designTokenPixels("--spacing-space-3") / 2;
    const barrierHitRadius = designTokenPixels("--spacing-touch-target") / 2;
    const barrierMarkerSize = designTokenPixels("--spacing-space-6");
    const layers = [];
    const assets = collections.get("assets");
    const barriers = collections.get("barriers");
    const consequences = collections.get("consequences");
    if (activeLayers.includes("assets") && assets) {
      const filtered = filterCollection(assets, domain);
      layers.push(new GeoJsonLayer<MapFeature["properties"], PathStyleExtensionProps<MapFeature>>({
        id: "asset-segment-layer",
        data: filtered as never,
        pickable: true,
        stroked: true,
        filled: true,
        lineWidthMinPixels: lineWidth,
        pointRadiusMinPixels: assetPointRadius,
        extensions: [new PathStyleExtension({ dash: true })],
        getDashArray: (feature) => riskBandVisualStyle(feature.properties.riskBand).dashed ? [1, 1] : [0, 0],
        getLineColor: (feature) => tokenColor(riskBandVisualStyle(feature.properties.riskBand).lineToken, 220),
        getFillColor: (feature) => tokenColor(riskBandVisualStyle(feature.properties.riskBand).fillToken, 100),
        getPointRadius: assetPointRadius,
        onClick: ({ object }) => selectMapFeature(object, setSelectedFeature),
      }));
      const alarpAssets = filtered.features.filter((feature) => riskBandVisualStyle(feature.properties.riskBand).patterned);
      if (alarpAssets.length > 0) {
        const hatchTileSize = designTokenPixels("--spacing-space-12");
        const hatchStrokeWidth = designTokenPixels("--spacing-border-hairline");
        layers.push(new GeoJsonLayer<MapFeature["properties"], FillStyleExtensionProps<MapFeature>>({
          id: "asset-risk-alarp-hatch-layer",
          data: { type: "FeatureCollection", features: alarpAssets } as never,
          pickable: false,
          stroked: false,
          filled: true,
          getFillColor: tokenColor("--color-neutral-900", 220),
          fillPatternAtlas: createAlarpHatchAtlas(hatchTileSize, hatchStrokeWidth),
          getFillPattern: () => "diagonal-hatch",
          fillPatternMapping: {
            "diagonal-hatch": { x: 0, y: 0, width: hatchTileSize, height: hatchTileSize },
          },
          extensions: [new FillStyleExtension({ pattern: true })],
        }));
      }
    }
    if (activeLayers.includes("consequences") && consequences) {
      layers.push(new GeoJsonLayer<MapFeature["properties"]>({
        id: "consequence-layer",
        data: filterCollection(consequences, domain) as never,
        pickable: true,
        stroked: true,
        filled: true,
        lineWidthMinPixels: lineWidth,
        getLineColor: tokenColor("--color-warning", 210),
        getFillColor: tokenColor("--color-warning", 42),
        onClick: ({ object }) => selectMapFeature(object, setSelectedFeature),
      }));
    }
    if (activeLayers.includes("barriers") && barriers) {
      const mappedBarriers = selectBarrierMarkerFeatures(filterCollection(barriers, domain).features);
      const barrierCollection: MapFeatureCollection = { type: "FeatureCollection", features: mappedBarriers };
      layers.push(new GeoJsonLayer<MapFeature["properties"]>({
        id: "barrier-marker-hit-area",
        data: barrierCollection as never,
        pickable: true,
        pointType: "circle",
        pointRadiusMinPixels: barrierHitRadius,
        getPointRadius: barrierHitRadius,
        getFillColor: [0, 0, 0, 0],
        stroked: false,
        onClick: ({ object }) => selectMapFeature(object, setSelectedFeature),
      }));
      layers.push(new IconLayer<MapFeature>({
        id: "barrier-health-markers",
        data: mappedBarriers,
        iconAtlas: BARRIER_ICON_ATLAS,
        iconMapping: BARRIER_ICON_MAPPING,
        pickable: true,
        getPosition: (feature) => pointPosition(feature),
        getIcon: (feature) => barrierMarkerStatus(feature.properties.health) ?? "unverified",
        getSize: barrierMarkerSize,
        sizeUnits: "pixels",
        getColor: (feature) => healthColor(feature.properties.health),
        onClick: ({ object }) => selectMapFeature(object, setSelectedFeature),
      }));
    }
    baseLayers.current = layers;
    overlay.current.setProps({ layers });
  }, [activeLayers, collections, domain]);

  useEffect(() => {
    const mapBarriers = collections.get("barriers");
    const failed = activeLayers.includes("barriers") && mapBarriers
      ? filterCollection(mapBarriers, domain).features.filter((feature) => feature.properties.health === "failed")
      : [];
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lineWidth = designTokenPixels("--spacing-indicator-width");
    const failedPulseRadius = designTokenPixels("--spacing-space-5");
    const renderPulse = () => {
      if (!overlay.current) return;
      const pulseLayer = failed.length === 0 ? [] : [new ScatterplotLayer<MapFeature>({
        id: "failed-barrier-pulse",
        data: failed,
        pickable: false,
        stroked: true,
        filled: false,
        lineWidthMinPixels: lineWidth,
        radiusUnits: "pixels",
        getPosition: (feature) => pointPosition(feature),
        getRadius: failedPulseRadius,
        getLineColor: (feature) => {
          const [red, green, blue] = healthColor(feature.properties.health);
          return [red, green, blue, reducedMotion ? 150 : Math.round(pulseOpacity.current * 255)];
        },
      })];
      overlay.current.setProps({ layers: [...baseLayers.current, ...pulseLayer] });
    };

    renderPulse();
    if (failed.length === 0 || reducedMotion) return;
    const timer = window.setInterval(() => {
      const phase = (Date.now() % 1_600) / 1_600;
      pulseOpacity.current = 0.15 + 0.65 * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2));
      renderPulse();
    }, 160);
    return () => window.clearInterval(timer);
  }, [activeLayers, collections, domain]);

  const moveToStory = (story: "pipeline-integrity" | "flood-water") => {
    const target = story === "pipeline-integrity" ? PIPELINE_VIEW : FLOOD_VIEW;
    setDomain(story);
    map.current?.moveCamera({ center: { lat: target.latitude, lng: target.longitude }, zoom: target.zoom, heading: target.heading, tilt: target.tilt });
  };

  const changeZoom = (difference: number) => {
    const mapInstance = map.current;
    if (mapInstance) mapInstance.setZoom((mapInstance.getZoom() ?? viewport.zoom) + difference);
  };

  const changeTilt = (tilt: 0 | 45) => {
    map.current?.moveCamera({ tilt, heading: tilt === 0 ? 0 : viewport.heading });
  };

  const chooseFeature = (feature: MapFeature) => {
    setSelectedFeature(feature);
    const position = pointPosition(feature);
    const center = { lat: position[1], lng: position[0] };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      map.current?.moveCamera({ center });
    } else {
      map.current?.panTo(center);
    }
  };

  return <main id="main-content" className="geo-command-map" tabIndex={-1}>
    <nav className="nav-rail" aria-label={t("primaryNavigation")}>
      <a className="nav-rail-item nav-rail-item-active" href="/map" aria-current="page" aria-label={t("mapNav")} title={t("mapNav")}>
        <span aria-hidden="true">⌖</span><span>{t("mapNav")}</span>
      </a>
      <button className="nav-rail-item" type="button" aria-label={t("layers")} title={t("layers")} onClick={() => document.querySelector<HTMLElement>("#map-layer-controls > summary")?.focus()}>
        <span aria-hidden="true">▤</span><span>{t("layers")}</span>
      </button>
    </nav>

    <section className="map-stage" aria-label={t("map") }>
      <div className="map-toolbar">
        <div className="map-heading">
          <div><h1>{t("map")}</h1></div>
          <label className="map-search-label" htmlFor="map-search">{t("searchMap")}</label>
          <input id="map-search" className="map-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchPlaceholder")} />
        </div>
        <div className="map-filter-row" aria-label={t("demoStoryline")}>
          <button type="button" className="filter-chip" aria-pressed={domain === "all"} onClick={() => setDomain("all")}>{t("allDomains")}</button>
          <button type="button" className="filter-chip" aria-pressed={domain === "pipeline-integrity"} onClick={() => moveToStory("pipeline-integrity")}>{t("pipelineStory")}</button>
          <button type="button" className="filter-chip" aria-pressed={domain === "flood-water"} onClick={() => moveToStory("flood-water")}>{t("floodStory")}</button>
        </div>
      </div>

      <div className="map-canvas-wrap">
        <div ref={mapElement} className="map-canvas" role="region" aria-label={t("interactiveMap")} />
        {(!mapConfig.data || mapLoadFailed) && <div className="map-status" role={mapConfig.isError || mapLoadFailed ? "alert" : "status"}>
          <p>{mapLoadFailed ? t("mapLoadError") : mapConfig.isError ? t("mapConfigError") : t("mapLoading")}</p>
          {mapConfig.isError && <button type="button" onClick={() => { void mapConfig.refetch(); }}>{t("retry")}</button>}
          {mapLoadFailed && <button type="button" onClick={() => { setMapLoadFailed(false); setMapRetry((current) => current + 1); }}>{t("retry")}</button>}
        </div>}
        {mapConfig.data && layerError && <p className="map-inline-alert" role="alert">{t("mapLayerError")}</p>}
        <div className="map-overlay-top">
          <div className="map-view-controls" role="group" aria-label={t("mapControls")}>
            <button type="button" className="map-view-preset" aria-label={t("obliqueView")} aria-pressed={viewport.tilt >= 30} onClick={() => changeTilt(45)}><span className="mono">45°</span></button>
            <button type="button" className="map-view-preset" aria-label={t("topDownView")} aria-pressed={viewport.tilt === 0} onClick={() => changeTilt(0)}><span className="mono">0°</span></button>
            <button type="button" aria-label={t("zoomIn")} onClick={() => changeZoom(1)}>+</button>
            <button type="button" aria-label={t("zoomOut")} onClick={() => changeZoom(-1)}>−</button>
          </div>
          <details className="layer-control map-layer-control" id="map-layer-controls" open>
            <summary>{t("layers")}</summary>
            <fieldset>
              <legend>{t("visibleMapLayers")}</legend>
              {LAYERS.map((layer) => <label key={layer} className="layer-option">
                <input type="checkbox" checked={activeLayers.includes(layer)} onChange={() => setActiveLayers((current) => current.includes(layer) ? current.filter((item) => item !== layer) : [...current, layer])} />
                <span>{t(layer)}</span>
              </label>)}
            </fieldset>
          </details>
        </div>
        <div className="map-legend" aria-label={t("mapLegend")}>
          <div className="legend-group">
            <h2>{t("barrierHealth")}</h2>
            <span className="legend-health"><i className="health-failed" aria-hidden="true">{SYMBOLS.failed}</i>{t("failed")}</span>
            <span className="legend-health"><i className="health-degraded" aria-hidden="true">{SYMBOLS.degraded}</i>{t("degraded")}</span>
            <span className="legend-health"><i className="health-unverified" aria-hidden="true">{SYMBOLS.unverified}</i>{t("unverified")}</span>
          </div>
          <div className="legend-group legend-risk-group">
            <h2>{t("riskLegend")}</h2>
            <span><i className="legend-risk legend-intolerable" />{t("intolerable")}</span>
            <span><i className="legend-risk legend-alarp" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 14 14 2M2 8 8 2M8 14l6-6" /></svg></i>{t("alarp")}</span>
            <span><i className="legend-risk legend-acceptable" />{t("acceptable")}</span>
          </div>
        </div>
      </div>
      <footer className="timeline-bar">
        <div className="timeline-state"><span className="live-dot" aria-hidden="true" />{t("liveMapView")}</div>
        <div className="timeline-track" aria-label={t("currentViewport")}>
          <span>{t("viewportCenter")}</span><code>{viewport.latitude.toFixed(5)}, {viewport.longitude.toFixed(5)}</code>
        </div>
        <div className="timeline-alerts" aria-live="polite">
          {t("visibleAlerts", { count: featureCounts.degraded + featureCounts.failed + featureCounts.unverified })}
        </div>
      </footer>
    </section>

    <aside className="context-panel" aria-label={t("contextPanel")}>
      <header className="context-header">
        <div><p className="eyebrow">{t("mapSelection")}</p><h2>{selectedFeature?.properties.name ?? t("overview")}</h2>
          {selectedFeature?.properties.chainageFrom !== null && selectedFeature?.properties.chainageFrom !== undefined &&
            <p className="context-chainage mono">{t("chainage")} {formatChainage(selectedFeature.properties.chainageFrom)}–{formatChainage(selectedFeature.properties.chainageTo ?? selectedFeature.properties.chainageFrom)} m</p>}
        </div>
        {selectedFeature?.properties.code && <code className="context-code">{selectedFeature.properties.code}</code>}
      </header>
      <div className="context-tabs">
        <span className="context-tab-active">{t("overview")}</span>
      </div>
      <div className="context-body" tabIndex={0}>
        <MapOverviewSummary summary={contextSummary} />
        {selectedFeature ? <FeatureOverview feature={selectedFeature} /> : <p className="context-hint">{t("selectMapFeature")}</p>}
        <section className="feature-list-section" aria-labelledby="visible-features-title">
          <div className="section-heading"><h3 id="visible-features-title">{t("visibleFeatures")}</h3><span className="mono">{features.length}</span></div>
          {features.length === 0 ? <p className="empty-note">{bounds ? t("noFeaturesInView") : t("mapLoading")}</p> : <ul className="feature-list">
            {features.slice(0, 150).map((feature) => <li key={`${feature.properties.featureKind}-${feature.id}`}>
              <button type="button" className="feature-list-item" onClick={() => chooseFeature(feature)}>
                <FeatureSymbol feature={feature} />
                <span className="feature-list-copy"><strong>{feature.properties.name ?? t("unnamedFeature")}</strong><span>{t(`featureKinds.${feature.properties.featureKind}`, { defaultValue: t("asset") })} · {feature.properties.health ? t(feature.properties.health) : feature.properties.riskBand ? t(feature.properties.riskBand) : t(`classifications.${feature.properties.classification}`, { defaultValue: feature.properties.classification ?? t("unknown") })}</span>
                  {feature.properties.featureKind === "segment" && (feature.properties.chainageFrom !== null || feature.properties.chainageTo !== null) &&
                    <span className="feature-list-chainage mono">{t("chainage")}: {feature.properties.chainageFrom ?? "?"}–{feature.properties.chainageTo ?? "?"} m</span>}
                </span>
                {feature.properties.simulated && <span className="sim-tag" lang="en" aria-label={t("healthProposalSimulationLabel")}>SIM</span>}
              </button>
            </li>)}
          </ul>}
          {features.length > 150 && <p className="empty-note">{t("featureListLimit", { count: 150 })}</p>}
        </section>
      </div>
      <footer className="context-footer">
        <span>{t("visibleDataScope")}</span>
        <span>{features[0] ? t(`classifications.${features[0].properties.classification}`, { defaultValue: features[0].properties.classification ?? t("unknown") }) : t("noFeatures")}</span>
      </footer>
    </aside>
  </main>;
}

type VisibleFeatureSummary = ReturnType<typeof summarizeVisibleFeatures>;

function MapOverviewSummary({ summary }: { summary: VisibleFeatureSummary }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const session = useCurrentSession();
  const proposalPages = useInfiniteQuery({
    queryKey: healthProposalsQueryKey,
    queryFn: ({ signal, pageParam }) => getHealthProposalPage(signal, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: 1,
  });
  const proposals = proposalPages.data?.pages.flatMap((page) => page.items.map((proposal) => ({
    id: proposal.id,
    barrierId: proposal.barrierId,
    ...(proposal.barrierName ? { barrierName: proposal.barrierName } : {}),
    ...(proposal.currentHealth ? { currentHealth: proposal.currentHealth as BarrierHealth } : {}),
    proposedHealth: proposal.proposedHealth as BarrierHealth,
    ...(proposal.sourceReason ? { sourceReason: proposal.sourceReason } : {}),
    simulated: proposal.simulated,
  }))) ?? [];
  const canDecide = Boolean(session.data?.roles.some((role) => role === "fieldloop.operator" || role === "fieldloop.manager"));
  const submitDecision = async (input: { proposalId: string; decision: "accept" | "reject"; reason: string; idempotencyKey: string }) => {
    if (!session.data) throw new Error("Session is unavailable");
    await decideHealthProposal({ ...input, csrfToken: session.data.csrfToken });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: healthProposalsQueryKey }),
      queryClient.invalidateQueries({ queryKey: ["map-layer", "barriers"] }),
    ]);
  };
  return <div className="context-overview-summary">
    <section className="context-summary-section" aria-labelledby="risk-summary-title">
      <h3 id="risk-summary-title">{t("riskSummary")}</h3>
      <p className="context-summary-scope">{t("visibleRiskSummary")}</p>
      <ul className="context-summary-list">
        {RISK_BANDS.map((band) => <li key={band} className={`risk-summary-row risk-${band}`}>
          <span className="context-risk-mark" aria-hidden="true" />
          <span>{t(band)}</span>
          <strong className="mono">{summary.riskBands[band]}</strong>
        </li>)}
      </ul>
    </section>
    <section className="context-summary-section" aria-labelledby="barrier-summary-title">
      <h3 id="barrier-summary-title">{t("barriersByHealth")}</h3>
      <p className="context-summary-scope">{t("visibleBarrierSummary")}</p>
      <ul className="context-summary-list">
        {BARRIER_HEALTH_STATES.map((health) => <li key={health} className="barrier-summary-row">
          <HealthBadge health={health} />
          <strong className="mono">{summary.barrierHealth[health]}</strong>
        </li>)}
      </ul>
    </section>
    <HealthProposalReview
      proposals={proposals}
      isLoading={proposalPages.isLoading}
      hasError={proposalPages.isError}
      canDecide={canDecide}
      hasMore={proposalPages.hasNextPage}
      isLoadingMore={proposalPages.isFetchingNextPage}
      onLoadMore={() => { void proposalPages.fetchNextPage(); }}
      onDecision={submitDecision}
    />
    <section className="context-summary-section" aria-labelledby="action-summary-title">
      <h3 id="action-summary-title">{t("openActionRequests")}</h3>
      <p className="empty-note">{t("actionRequestsUnavailable")}</p>
    </section>
  </div>;
}

function FeatureOverview({ feature }: { feature: MapFeature }) {
  const { t, i18n } = useTranslation();
  const health = feature.properties.health;
  return <dl className="feature-overview">
    <div><dt>{t("featureType")}</dt><dd>{t(`featureKinds.${feature.properties.featureKind}`, { defaultValue: t("asset") })}</dd></div>
    {feature.properties.chainageFrom !== null && feature.properties.chainageFrom !== undefined && <div><dt>{t("chainage")}</dt><dd className="mono">{formatChainage(feature.properties.chainageFrom)}–{formatChainage(feature.properties.chainageTo ?? feature.properties.chainageFrom)} m</dd></div>}
    <div><dt>{t("classification")}</dt><dd>{t(`classifications.${feature.properties.classification}`, { defaultValue: feature.properties.classification ?? t("unknown") })}</dd></div>
    {typeof feature.properties.simulated === "boolean" && <div><dt>{t("provenance")}</dt><dd>{feature.properties.simulated ? t("simulationLabel") : feature.properties.label ?? t("publicBaseMap")}</dd></div>}
    {health && <div><dt>{t("barrierHealth")}</dt><dd><HealthBadge health={health} /></dd></div>}
    {feature.properties.riskBand && <div><dt>{t("riskBand")}</dt><dd>{t(feature.properties.riskBand)}</dd></div>}
    {feature.properties.evidenceObservedAt && <div><dt>{t("latestEvidence")}</dt><dd><time className="mono" dateTime={feature.properties.evidenceObservedAt}>{new Date(feature.properties.evidenceObservedAt).toLocaleDateString(i18n.language === "th" ? "th-TH" : "en-GB", { timeZone: "Asia/Bangkok" })}</time></dd></div>}
  </dl>;
}

function HealthBadge({ health }: { health: string }) {
  const { t } = useTranslation();
  return <span className={`health-badge health-${health}`}><span aria-hidden="true">{SYMBOLS[health] ?? "●"}</span>{t(health)}</span>;
}

function FeatureSymbol({ feature }: { feature: MapFeature }) {
  const health = feature.properties.health;
  return <span className={`feature-symbol ${health ? `health-${health}` : ""}`} aria-hidden="true">
    {health ? SYMBOLS[health] ?? "●" : feature.properties.featureKind === "segment" ? "━" : feature.properties.featureKind === "consequence" ? "⬡" : "●"}
  </span>;
}

function filterCollection(collection: MapFeatureCollection, domain: "all" | "pipeline-integrity" | "flood-water"): MapFeatureCollection {
  if (domain === "all") return collection;
  return { type: "FeatureCollection", features: filterFeaturesByDomain(collection.features, domain) };
}

function selectMapFeature(value: unknown, setSelectedFeature: (feature: MapFeature) => void): boolean {
  if (!value || typeof value !== "object") return false;
  const feature = value as Partial<MapFeature>;
  if (feature.type !== "Feature" || typeof feature.id !== "string" || !feature.geometry || !feature.properties) return false;
  setSelectedFeature(feature as MapFeature);
  return true;
}

function pointPosition(feature: MapFeature): [number, number] {
  const geometry = feature.geometry;
  if (geometry.type === "Point") return [geometry.coordinates[0] ?? 0, geometry.coordinates[1] ?? 0];
  if (geometry.type === "LineString") return toPosition(geometry.coordinates[0]);
  if (geometry.type === "Polygon") return toPosition(geometry.coordinates[0]?.[0]);
  return toPosition(geometry.coordinates[0]?.[0]?.[0]);
}

function toPosition(value: number[] | undefined): [number, number] {
  return [value?.[0] ?? 0, value?.[1] ?? 0];
}

function healthColor(health: unknown): [number, number, number, number] {
  if (health === "degraded") return tokenColor("--color-health-degraded", 240);
  if (health === "failed") return tokenColor("--color-health-failed", 240);
  return tokenColor("--color-health-unverified", 240);
}

function tokenColor(token: string, alpha: number): [number, number, number, number] {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const match = /^#([\da-f]{6})$/i.exec(value);
  if (!match?.[1]) return [0, 0, 0, alpha];
  const color = Number.parseInt(match[1], 16);
  return [(color >> 16) & 255, (color >> 8) & 255, color & 255, alpha];
}

function designTokenPixels(token: string): number {
  const value = Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue(token));
  if (!Number.isFinite(value)) throw new Error(`Missing design token ${token}`);
  return value;
}

function createAlarpHatchAtlas(tileSize: number, strokeWidth: number): string {
  const halfTile = tileSize / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileSize}" height="${tileSize}" viewBox="0 0 ${tileSize} ${tileSize}"><path d="M0 ${tileSize}L${tileSize} 0M-${halfTile} ${tileSize}L${halfTile} 0M${halfTile} ${tileSize}L${tileSize + halfTile} 0" fill="none" stroke="white" stroke-width="${strokeWidth}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function readViewportFromSearch(params: Record<string, unknown>): MapViewport {
  const latitude = Number(params["lat"]);
  const longitude = Number(params["lng"]);
  const zoom = Number(params["zoom"]);
  const heading = Number(params["heading"]);
  const tilt = Number(params["tilt"]);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return DEFAULT_VIEW;
  return {
    latitude,
    longitude,
    zoom: Number.isInteger(zoom) && zoom >= 0 && zoom <= 22 ? zoom : DEFAULT_VIEW.zoom,
    heading: Number.isFinite(heading) ? heading : DEFAULT_VIEW.heading,
    tilt: tilt === 0 ? 0 : tilt === 45 ? 45 : DEFAULT_VIEW.tilt,
  };
}

function formatChainage(value: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(value);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
