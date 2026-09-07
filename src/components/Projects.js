import React from "react";
import { projects, archiveProjects } from "../data";
export default function Projects() {
  return (
    <section id="projects" className="work-section page-width">
      <div className="section-heading">
        <div>
          <p className="eyebrow">02 / SELECTED WORK</p>
          <h2>A few things I’ve made.</h2>
        </div>
        <a
          className="text-link"
          href="https://github.com/CashelF"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div className="project-grid">
        {projects.map((project, index) => (
          <a
            className="project robot-play-target"
            href={project.link}
            target="_blank"
            rel="noopener noreferrer"
            key={project.title}
            data-robot-target={project.title}
            data-robot-platform="card"
          >
            <div className={`project-image project-image--${index}`}>
              <img src={project.thumbnail} alt="" loading="lazy" />
              <span className="project-open" aria-hidden="true">
                ↗
              </span>
            </div>
            <div className="project-heading">
              <h3>{project.title}</h3>
              <span>{project.category}</span>
            </div>
            <p>{project.description}</p>
          </a>
        ))}
      </div>
      <details className="project-archive">
        <summary>
          More experiments <span aria-hidden="true">+</span>
        </summary>
        <div className="archive-list">
          {archiveProjects.map((project) => (
            <a
              href={project.link}
              target="_blank"
              rel="noopener noreferrer"
              key={project.title}
            >
              <span>{project.title}</span>
              <span>
                {project.category} <span aria-hidden="true">↗</span>
              </span>
            </a>
          ))}
        </div>
      </details>
    </section>
  );
}
