// src/components/Navbar.js

import { ArrowRightIcon } from "@heroicons/react/solid";
import React from "react";

export default function Navbar() {
  return (
    <header className="bg-black bg-opacity-80 glass md:sticky top-0 z-10 transition-all duration-300">
      <div className="container mx-auto flex flex-wrap p-5 flex-col md:flex-row items-center">
        <a className="title-font font-medium text-white mb-4 md:mb-0">
          <a href="#about" className="ml-3 text-xl" data-robot-target="Site title">
            Cashel Fitzgerald
          </a>
        </a>
        <nav className="md:mr-auto md:ml-4 md:py-1 md:pl-4 md:border-l md:border-gray-700	flex flex-wrap items-center text-base justify-center">
          <a href="#projects" className="mr-5 hover:text-white transition-colors" data-robot-target="Past Work nav link">
            Past Work
          </a>
          <a href="#skills" className="mr-5 hover:text-white transition-colors" data-robot-target="Skills nav link">
            Skills
          </a>
        </nav>
        <a
          href="#contact"
          data-robot-target="Hire Me button"
          className="inline-flex items-center bg-white border border-white py-1 px-3 focus:outline-none hover:bg-black hover:text-white rounded text-base mt-4 md:mt-0 text-black shadow-lg transition-colors">
          Hire Me
          <ArrowRightIcon className="w-4 h-4 ml-1" />
        </a>
      </div>
    </header>
  );
}
