import React from "react";
export default function About() {
  return (
    <section id="about" className="hero page-width">
      <div className="hero-copy">
        <p className="eyebrow">
          <span className="accent-dot" /> ENGINEER & FOUNDER
        </p>
        <h1>
          Hi, I’m Cash.
          <br />
          <span>A machine learning engineer.</span>
        </h1>
        <p className="hero-description">
          Co-founder & CTO at{" "}
          <a
            href="https://www.zommalabs.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Zomma <span aria-hidden="true">↗</span>
          </a>
          .<br />
          Building computer-use agents for the financial back office.
        </p>
        <a className="text-link" href="#brain">
          Meet Marvin, my diffusion model <span aria-hidden="true">↓</span>
        </a>
      </div>
      <figure className="hero-portrait">
        <img
          src="./cashel_animated.png"
          alt="Caricature of Cash"
          width="1024"
          height="1024"
          data-robot-target="Caricature of Cash"
          data-robot-contour="true"
        />
        <figcaption>
          <span>Cashel Fitzgerald</span>
          <span>San Francisco, CA</span>
        </figcaption>
      </figure>
      <div className="hero-footnote">
        <span>Previously Modern Intelligence</span>
        <span>Cornell CS · UT Austin ECE</span>
      </div>
    </section>
  );
}
