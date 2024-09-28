// src/components/Projects.js

import { CodeIcon } from "@heroicons/react/solid";
import React from "react";
import { projects } from "../data";
import '../styles/Project.scss';

export default function Projects() {
  // Separate hosted and non-hosted projects
  const hostedProjects = projects.filter((project) => project.hosted);
  const otherProjects = projects.filter((project) => !project.hosted);

  return (
    <section id="projects" className="projects-container text-gray-400 bg-gray-900 body-font">
      <div className="container px-5 py-10 mx-auto text-center lg:px-40">
        <div className="flex flex-col w-full mb-20">
          <CodeIcon className="mx-auto inline-block w-10 mb-4" />
          <h1 className="sm:text-4xl text-3xl font-medium title-font mb-4 text-white">
            Hosted Projects
          </h1>
          <p className="lg:w-2/3 mx-auto leading-relaxed text-base">
            These projects are live and hosted online. Check them out!
          </p>
        </div>
        <div className="projects-grid flex flex-wrap -m-4">
          {hostedProjects.map((project) => (
            <div className="project sm:w-1/2 w-100 p-4" key={project.image}>
              <a href={project.link} target="_blank" rel="noreferrer">
                <img src={project.image} className="zoom mb-2" alt="project gif" />
                <h2 className="tracking-widest text-sm title-font font-medium text-purple-400 mb-2">
                  {project.subtitle}
                </h2>
                <h1 className="title-font text-lg font-medium text-white mb-3">
                  {project.title}
                </h1>
                <p className="leading-relaxed">{project.description}</p>
              </a>
            </div>
          ))}
        </div>

        {/* Non-hosted projects */}
        <div className="flex flex-col w-full mb-20 mt-10">
          <h1 className="sm:text-4xl text-3xl font-medium title-font mb-4 text-white">
            Other Projects
          </h1>
          <p className="lg:w-2/3 mx-auto leading-relaxed text-base">
            These are some other projects that I have worked on.
          </p>
        </div>
        <div className="projects-grid flex flex-wrap -m-4">
          {otherProjects.map((project) => (
            <div className="project sm:w-1/2 w-100 p-4" key={project.image}>
              <a href={project.link} target="_blank" rel="noreferrer">
                <img src={project.image} className="zoom mb-2" alt="project gif" />
                <h2 className="tracking-widest text-sm title-font font-medium text-purple-400 mb-2">
                  {project.subtitle}
                </h2>
                <h1 className="title-font text-lg font-medium text-white mb-3">
                  {project.title}
                </h1>
                <p className="leading-relaxed">{project.description}</p>
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}