import React from "react";
export default function Contact() {
  return (
    <footer id="contact" className="contact-section page-width">
      <p className="eyebrow">03 / GET IN TOUCH</p>
      <div className="contact-heading">
        <h2>Have something in mind?</h2>
        <a
          href="mailto:cashel@utexas.edu"
          className="contact-link"
          data-robot-target="Email Cash"
        >
          Say hello <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} Cashel Fitzgerald</span>
        <div>
          <a
            href="https://github.com/CashelF"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub ↗
          </a>
          <a
            href="https://www.linkedin.com/in/cashelfitzgerald"
            target="_blank"
            rel="noopener noreferrer"
          >
            LinkedIn ↗
          </a>
          <a
            href="https://www.zommalabs.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Zomma ↗
          </a>
        </div>
      </div>
    </footer>
  );
}
