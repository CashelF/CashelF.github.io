import React from "react";
import About from "./components/About";
import Contact from "./components/Contact";
import Navbar from "./components/Navbar";
import NeuralNetworkBackground from "./components/NeuralNetworkBackground";
import Projects from "./components/Projects";
import SiteRobot from "./components/SiteRobot";
import Skills from "./components/Skills";

export default function App() {
  const mainRef = React.useRef(null);

  return (
    <div className="app-wrapper">
      <NeuralNetworkBackground />
      <main
        ref={mainRef}
        className="text-gray-400 body-font"
        style={{ position: 'relative', zIndex: 1 }}
      >
        <Navbar />
        <About />
        <Projects />
        <Skills />
        <Contact />
        <SiteRobot scopeRef={mainRef} />
      </main>
    </div>
  );
}
