import React from "react";
import About from "./components/About";
import Contact from "./components/Contact";
import Navbar from "./components/Navbar";
import NeuralNetworkBackground from "./components/NeuralNetworkBackground";
import Projects from "./components/Projects";
import Skills from "./components/Skills";

export default function App() {
  return (
    <div className="app-wrapper">
      <NeuralNetworkBackground />
      <main className="text-gray-400 body-font" style={{ position: 'relative', zIndex: 1 }}>
        <Navbar />
        <About />
        <Projects />
        <Skills />
        <Contact />
      </main>
    </div>
  );
}
