import { createRoot } from "react-dom/client";
import { StripBand } from "../src/StripBand";
import { stripBandFixture } from "./strip-band-fixture";
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
createRoot(root).render(<>
  <a href="#strip-fixture-main" lang="en" className="strip-fixture-skip">Skip to static strip</a>
  <main id="strip-fixture-main" tabIndex={-1}>
    <h1 lang="en">SYNTHETIC static strip fixture</h1>
    <StripBand data={stripBandFixture} language={language} />
  </main>
</>);
