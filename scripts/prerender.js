const fs = require("fs");
const path = require("path");
require("./register-static");
const React = require("react");
const { renderToString } = require("react-dom/server");
const Site = require("../src/Site").default;
const { ThemeProvider } = require("../src/siteTheme");
const { pages, site, notFoundPage } = require("../src/content");
const { pageTitle, structuredData } = require("../src/seo");

const build = path.resolve(__dirname, "../build");
const template = fs.readFileSync(path.join(build, "index.html"), "utf8");
const escape = value => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function replaceOnce(html, pattern, replacement) {
  let count = 0;
  const result = html.replace(pattern, () => { count += 1; return replacement; });
  if (count !== 1) throw new Error(`Expected one template match for ${pattern}, found ${count}`);
  return result;
}

for (const page of pages.concat(notFoundPage)) {
  const url = site.origin + page.path;
  let html = replaceOnce(template, /<title>[^<]*<\/title>/g, `<title>${escape(pageTitle(page))}</title>`);
  const meta = [
    ["name", "description", page.description],
    ["name", "robots", page.noindex ? "noindex, follow" : "index, follow, max-image-preview:large"],
    ["property", "og:title", pageTitle(page)],
    ["property", "og:description", page.description],
    ["property", "og:url", url],
    ["property", "og:type", page.path.startsWith("/projects/") ? "article" : "website"],
    ["name", "twitter:title", pageTitle(page)],
    ["name", "twitter:description", page.description],
  ];
  for (const [attribute, name, value] of meta) {
    html = replaceOnce(html, new RegExp(`<meta ${attribute}="${name}"[^>]*>`, "g"), `<meta ${attribute}="${name}" content="${escape(value)}"/>`);
  }
  html = replaceOnce(html, /<link rel="canonical"[^>]*>/g, `<link rel="canonical" href="${escape(url)}"/>`);
  html = replaceOnce(html, /<script id="site-schema"[^>]*>[\s\S]*?<\/script>/g,
    `<script id="site-schema" type="application/ld+json">${JSON.stringify(structuredData(page)).replace(/</g, "\\u003c")}</script>`);
  const content = renderToString(React.createElement(ThemeProvider, null, React.createElement(Site, { page })));
  html = replaceOnce(html, /<div id="root"><\/div>/g, `<div id="root">${content}</div>`);
  const filename = page.noindex ? path.join(build, "404.html") : path.join(build, page.path, "index.html");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, html);
  console.log(`Rendered ${page.path}`);
}

fs.writeFileSync(path.join(build, "sitemap.xml"),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  pages.map(page => `  <url><loc>${site.origin}${page.path}</loc></url>`).join("\n") + "\n</urlset>\n");
