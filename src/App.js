import React from "react";
import Site from "./Site";
import { pageForPath, site } from "./content";
import { pageTitle, structuredData } from "./seo";
import SiteRobot from "./components/SiteRobot";
import MarvinBrain from "./components/MarvinBrain";
import NeuralNetworkBackground from "./components/NeuralNetworkBackground";
import { ThemeProvider, useTheme } from "./siteTheme";
export default function App() {
  return <ThemeProvider><Portfolio /></ThemeProvider>;
}
function Portfolio() {
  const mainRef = React.useRef(null);
  const { theme } = useTheme();
  const [interactive, setInteractive] = React.useState(false);
  const page = pageForPath(window.location.pathname);
  React.useEffect(() => {
    setInteractive(true);
    // Production pages already contain this metadata; keep direct dev URLs accurate too.
    document.title = pageTitle(page);
    const values = {
      'meta[name="description"]': page.description,
      'meta[name="robots"]': page.noindex ? "noindex, follow" : "index, follow, max-image-preview:large",
      'meta[property="og:title"]': pageTitle(page),
      'meta[property="og:description"]': page.description,
      'meta[property="og:url"]': site.origin + page.path,
      'meta[property="og:type"]': page.path.startsWith("/projects/") ? "article" : "website",
      'meta[name="twitter:title"]': pageTitle(page),
      'meta[name="twitter:description"]': page.description,
    };
    Object.keys(values).forEach(selector => {
      const element = document.querySelector(selector);
      if (element) element.setAttribute("content", values[selector]);
    });
    document.querySelector('link[rel="canonical"]').href = site.origin + page.path;
    document.getElementById("site-schema").textContent = JSON.stringify(structuredData(page));
  }, [page]);
  return (
    <Site page={page} mainRef={mainRef}
      background={interactive && page.path === "/" && <NeuralNetworkBackground theme={theme} />}
      brain={interactive && page.path === "/" && <MarvinBrain />}
      robot={interactive && page.path === "/" && <SiteRobot scopeRef={mainRef} />}
    />
  );
}
