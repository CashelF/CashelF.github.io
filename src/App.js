import React from "react";
import About from "./components/About";
import Contact from "./components/Contact";
import Navbar from "./components/Navbar";
import Projects from "./components/Projects";
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
  return (
    <div className="app-wrapper">
      <NeuralNetworkBackground theme={theme} />
      <a href="#about" className="skip-link">
        Skip to content
      </a>
      <main ref={mainRef} style={{ position: "relative", zIndex: 1 }}>
        <Navbar />
        <About />
        <MarvinBrain />
        <Projects />
        <Contact />
        <SiteRobot scopeRef={mainRef} />
      </main>
    </div>
  );
}
