import { CodeIcon } from "@heroicons/react/solid";
import React from "react";
import { projects } from "../data";
import BentoBox from "./BentoBox";

const bentoGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: '1.25rem',
  padding: '1rem 0',
};

const bentoGridStyleMobile = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: '0.75rem',
  padding: '0.75rem 0',
};

export default function Projects() {
  const hostedProjects = projects.filter((project) => project.hosted);
  const otherProjects = projects.filter((project) => !project.hosted);

  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const gridStyle = isMobile ? bentoGridStyleMobile : bentoGridStyle;

  return (
    <section id="projects" className="text-gray-400 bg-transparent body-font">
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
        <div style={gridStyle}>
          {hostedProjects.map((project) => (
            <BentoBox 
              key={project.title}
              project={project} 
            />
          ))}
        </div>

        <div className="flex flex-col w-full mb-20 mt-20">
          <h1 className="sm:text-4xl text-3xl font-medium title-font mb-4 text-white">
            Other Projects
          </h1>
          <p className="lg:w-2/3 mx-auto leading-relaxed text-base">
            These are some other projects that I have worked on.
          </p>
        </div>
        <div style={gridStyle}>
          {otherProjects.map((project) => (
            <BentoBox 
              key={project.title}
              project={project} 
            />
          ))}
        </div>
      </div>
    </section>
  );
}
