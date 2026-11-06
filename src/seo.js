import { site } from "./content";

export function pageTitle(page) {
  return page.title.includes(site.name) ? page.title : `${page.title} — ${site.name}`;
}

export function structuredData(page) {
  const personId = `${site.origin}/#person`;
  const url = site.origin + page.path;
  const person = {
    "@type": "Person", "@id": personId,
    name: site.name, url: `${site.origin}/`,
    image: `${site.origin}/cashel_animated.png`,
    jobTitle: "Co-founder & CTO",
    description: site.bio,
    worksFor: { "@type": "Organization", "@id": "https://www.zommalabs.com/#organization", name: "Zomma", url: "https://www.zommalabs.com/" },
    sameAs: ["https://github.com/CashelF", "https://www.linkedin.com/in/cashelfitzgerald"]
  };
  const profile = page.path === "/" || page.path === "/about/";
  const webPage = Object.assign({
    "@type": profile ? "ProfilePage" : "WebPage", "@id": `${url}#webpage`,
    url, name: pageTitle(page), description: page.description,
    isPartOf: { "@id": `${site.origin}/#website` },
  }, profile ? { mainEntity: { "@id": personId } } : { about: { "@id": personId } });
  const graph = [
    { "@type": "WebSite", "@id": `${site.origin}/#website`, url: `${site.origin}/`, name: site.name, publisher: { "@id": personId } },
    person, webPage
  ];
  if (!profile && !page.noindex) {
    graph.push({
      "@type": "Article", "@id": `${url}#article`, url,
      headline: page.title, description: page.description,
      author: { "@id": personId }, mainEntityOfPage: { "@id": `${url}#webpage` },
      image: `${site.origin}${page.image || "/social-card.png"}`,
      citation: page.sections.reduce((all, section) => all.concat((section.links || []).map(link => link.href.startsWith("/") ? site.origin + link.href : link.href)), [])
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}
