import React from "react";
import About from "./components/About";
import Contact from "./components/Contact";
import Navbar from "./components/Navbar";
import Projects from "./components/Projects";
import { articles, site } from "./content";

function Article({ page }) {
  return (
    <article id="content" className="article page-width">
      <a className="text-link" href="/">← Back to home</a>
      <header className="article-header">
        <p className="eyebrow">{page.category}</p>
        <h1>{page.title}</h1>
        <p className="article-summary">{page.summary}</p>
        {page.path !== "/about/" && <p className="article-credit">By <a href="/about/">Cashel Fitzgerald</a>{page.credit && <span> · {page.credit}</span>}</p>}
      </header>
      {page.image && <img className="article-image" src={page.image} alt={page.imageAlt} />}
      <div className="article-body">
        {page.sections.map(section => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
            {section.links && <ul>{section.links.map(link => <li key={link.href}><a href={link.href}>{link.label} <span aria-hidden="true">↗</span></a></li>)}</ul>}
          </section>
        ))}
        <nav className="related-work" aria-label="More to explore">
          <h2>More to explore</h2>
          <ul>{articles.filter(article => article.path !== page.path).map(article => <li key={article.path}><a href={article.path}>{article.title}</a></li>)}</ul>
        </nav>
      </div>
    </article>
  );
}

export default function Site({ page, mainRef, background, brain, robot }) {
  const home = page.path === "/";
  return (
    <div className="app-wrapper">
      {background}
      <a href={home ? "#about" : "#content"} className="skip-link">Skip to content</a>
      <div ref={mainRef} style={{ position: "relative", zIndex: 1 }}>
        <Navbar home={home} />
        <main>
          {home ? (
            <React.Fragment>
              <About />
              <section className="bio-section page-width" aria-labelledby="bio-title">
                <h2 id="bio-title">Building useful machine learning systems.</h2>
                <div><p>{site.bio}</p><p>My background includes Cornell CS, UT Austin ECE, and work at Modern Intelligence. My projects explore reinforcement learning, visual speech recognition, and diffusion language models.</p><a className="text-link" href="/about/">More about Cashel Fitzgerald <span aria-hidden="true">→</span></a></div>
              </section>
              <section id="brain" className="brain-section page-width" aria-labelledby="brain-title">
                <div className="section-heading">
                  <div><p className="eyebrow">01 / LIVE DIFFUSION</p><h2 id="brain-title">Marvin’s brain.</h2></div>
                  <a className="text-link" href="/projects/marvin/">How I built it <span aria-hidden="true">→</span></a>
                </div>
                <p className="brain-description">Marvin is my interactive diffusion language model demo. Follow real token states and measured hidden activations as a Qwen3 0.6B model generates a response.</p>
                {brain || <div className="brain-placeholder"><p>The interactive model loads with JavaScript.</p><a href="/projects/marvin/">Read about the architecture, measurements, and limitations →</a></div>}
              </section>
              <Projects />
            </React.Fragment>
          ) : page.noindex ? (
            <section id="content" className="article page-width"><h1>Page not found.</h1><p>Explore my <a href="/about/">background</a> or <a href="/#projects">selected work</a>.</p><a className="text-link" href="/">← Back to home</a></section>
          ) : <Article page={page} />}
        </main>
        <Contact />
        {robot}
      </div>
    </div>
  );
}
