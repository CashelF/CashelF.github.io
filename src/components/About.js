// src/components/About.js

import React from "react";

export default function About() {
  return (
    <section id="about">
      <div className="container mx-auto flex px-10 py-20 md:flex-row flex-col items-center">
        <div className="lg:flex-grow md:w-1/2 lg:pr-24 md:pr-16 flex flex-col md:items-start md:text-left mb-16 md:mb-0 items-center text-center">
          <h1 className="title-font sm:text-4xl text-3xl mb-4 font-medium text-white">
            Hi, I'm Cash.
            <br className="hidden lg:inline-block" /> A Machine Learning Engineer.
          </h1>
          <p className="mb-8 leading-relaxed">
            Cornell CS Master's student (B.S. ECE, UT Austin) and Machine Learning Engineer at Modern Intelligence specializing in distributed training and computer vision. My recent work focuses on building scalable, production-ready ML systems, including scaling DETR architectures to multi-node clusters and building large-scale auto-annotation and knowledge distillation pipelines. I am passionate about bridging research and application.
          </p>
          <div className="flex justify-center">
            <a
              href="#contact"
              className="inline-flex text-white bg-purple-700 border-0 py-2 px-6 focus:outline-none hover:bg-purple-800 rounded text-lg">
              Work With Me
            </a>
            <a
              href="#projects"
              className="ml-4 inline-flex text-gray-400 bg-gray-800 border-0 py-2 px-6 focus:outline-none hover:bg-gray-700 hover:text-white rounded text-lg">
              See My Past Work
            </a>
          </div>
        </div>
        <div className="lg:max-w-lg lg:w-full md:w-1/2 w-5/6">
          <img
            className="object-cover object-center rounded"
            alt="hero"
            src="./cashel_animated.png"
          />
        </div>
      </div>
    </section>
  );
}