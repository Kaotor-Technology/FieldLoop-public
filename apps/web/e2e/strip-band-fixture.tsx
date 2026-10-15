import { createRoot } from "react-dom/client";
import { StripBand } from "../src/StripBand";
import { stripBandFixture } from "./strip-band-fixture";
import "../src/styles.css";
import "@fontsource/ibm-plex-sans-thai/400.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fieldloop/ui/styles.css";
import "./strip-band-fixture.css";

const params = new URLSearchParams(location.search);
const language = params.get("language") === "th" ? "th" : "en";
document.documentElement.dataset["theme"] = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.lang = language;
const root = document.getElementById("root");
if (!root) throw new Error("Missing synthetic fixture root");
const strip = <StripBand data={stripBandFixture} language={language} />;
const mapLayout = params.get("layout") === "map";
createRoot(root).render(mapLayout ? <div className="app-shell">
  <a href="#strip-fixture-main" lang="en" className="skip-link">Skip to static map</a>
  <header className="top-bar">Synthetic header</header>
  <div className="workspace-banner">SIMULATION fixture</div>
  <div className="map-entry">
    <section className="bowtie-list"><h2>Seeded Bowties</h2></section>
    <main id="strip-fixture-main" className="geo-command-map geo-command-map-with-strip" tabIndex={-1}>
      <nav className="nav-rail">Map</nav>
      <section className="map-stage">
        <div className="map-toolbar">Synthetic map controls</div>
        <div className="map-canvas-wrap"><div className="map-canvas">Synthetic map canvas</div></div>
        <footer className="timeline-bar">Synthetic timeline</footer>
      </section>
      <section className="chainage-strip-dock" aria-label="DL-01 Chainage strip">{strip}</section>
      <aside className="context-panel">Synthetic context panel</aside>
    </main>
  </div>
  <div className="simulation-controls">Simulation fixture</div>
</div> : <>
  <a href="#strip-fixture-main" lang="en" className="strip-fixture-skip">Skip to static strip</a>
  <main id="strip-fixture-main" tabIndex={-1}>
    <h1 lang="en">SYNTHETIC static strip fixture</h1>
    {strip}
  </main>
</>);
