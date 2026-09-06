import React from "react";
import { useTheme } from "../siteTheme";
export default function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const dark = theme === "dark";
  return (
    <header className="site-header page-width">
      <a
        href="#about"
        className="wordmark"
        aria-label="Cashel Fitzgerald, home"
      >
        cf<span>.</span>
      </a>
      <nav aria-label="Main navigation">
        <a href="#brain">Marvin’s brain</a>
        <a href="#projects">Work</a>
        <a href="#contact">
          Say hello <span aria-hidden="true">↗</span>
        </a>
        <button
          className="theme-toggle"
          type="button"
          onClick={toggleTheme}
          aria-label={dark ? "Switch to day mode" : "Switch to night mode"}
          aria-pressed={dark}
          title={dark ? "Day mode" : "Night mode"}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {dark ? (
              <React.Fragment>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </React.Fragment>
            ) : <path d="M20.7 13.2A9 9 0 0 1 10.8 3.3 9 9 0 1 0 20.7 13.2Z" />}
          </svg>
        </button>
      </nav>
    </header>
  );
}
