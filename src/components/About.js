// src/components/About.js

import React from "react";

export default function About() {
  return (
    <section id="about">
      <div className="container mx-auto flex px-10 py-20 md:flex-row flex-col items-center">
        <div className="lg:flex-grow md:w-1/2 lg:pr-24 md:pr-16 flex flex-col md:items-start md:text-left mb-16 md:mb-0 items-center text-center">
          <h1 className="title-font sm:text-4xl text-3xl mb-4 font-medium text-white">
            Hi, I'm Cash.
            <br className="hidden lg:inline-block" /> A Software Engineer.
          </h1>
          <p className="mb-8 leading-relaxed">
            I'm an Electrical and Computer Engineering student at UT Austin, specifically interested in software engineering. I have experience with backend software development in Java and Scala from summer internships at a fintech and a delivery service company. I also have experience with frontend development in React from my work on personal projects. I'm in the market for a software engineering internship over the coming summer.
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