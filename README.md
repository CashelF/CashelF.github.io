# cashel.dev

Cashel Fitzgerald’s personal site: current work at Zomma, selected projects, and
Marvin, a diffusion language model with live token states, an explorable
architecture, and measured hidden activations.

## Run locally

```bash
npm ci --legacy-peer-deps
npm start
```

This existing Create React App / CRACO toolchain runs with Node 16.20.2. Newer
Node versions may require `NODE_OPTIONS=--openssl-legacy-provider` for its older
Webpack version. The frontend is served at http://localhost:3000.

```bash
npm run build
npm run verify:static
CI=true npm test -- --env=node --runInBand
```

The production build is a static site in `build/`; `npm run deploy` publishes it
to this repository’s GitHub Pages branch for `cashel.dev`, preserving the
independently hosted `kd-detr-presentation/` directory.

## Search and AI discovery

`npm run build` runs `scripts/prerender.js` after compilation. It renders the
shared React components into complete HTML for `/`, `/about/`, and the three
`/projects/` write-ups. The browser hydrates that HTML and then mounts Marvin
and the animated background. Biography, project descriptions, navigation, and
source links remain readable with JavaScript disabled.

`src/content.js` owns page content and routes; `src/seo.js` generates titles and
linked Person, WebSite, ProfilePage, and Article data. Each generated page has
its own canonical, description, sharing metadata, and structured data. The build
generates the sitemap from those same routes, excluding the noindex 404 page.
Update `public/sitemap.xml` too when adding routes so the development server
continues to expose the current sitemap. Use `npm run build`, not a direct
`craco build`, when packaging a release.

`npm run verify:static` requires Python 3.9+ and checks the built HTML without
executing JavaScript: content, canonicals, structured data, internal links,
assets, and sitemap coverage. Deployment runs that check before publishing.
The share card can be regenerated independently with
`python3 scripts/generate_brand_assets.py --card-only`.

### Account setup and measurement

Keep `https://cashel.dev/` as the primary URL. The roots of
`cashelfitzgerald.com` and `fitzgerald.cash` already permanently redirect there;
keep redirects preserving paths when adding pages. Use the primary URL on
public profiles.

After publishing:

1. In [Google Search Console](https://search.google.com/search-console), verify
   the `cashel.dev` property, submit `https://cashel.dev/sitemap.xml`, and inspect
   the homepage and all four new pages. Check Google's chosen canonical,
   retrieved HTML, crawl status, and indexing status. Request indexing for the
   updated homepage and new pages when available.
2. In [Bing Webmaster Tools](https://www.bing.com/webmasters/), verify or import
   the same site and submit the sitemap. Check URL Inspection, crawl issues,
   and the AI Performance report when data becomes available.
3. In Cloudflare, check AI Crawl Control and security events for OAI-SearchBot
   and other desired search crawlers. The deployed robots file includes
   Cloudflare-managed rules in addition to `public/robots.txt`. Search access
   should remain allowed; changing training preferences is not necessary.
   A request using a bot's user-agent from a developer's machine does not prove
   that requests from the crawler's real IP addresses pass the firewall.
4. Keep the website field on GitHub and LinkedIn set to `https://cashel.dev/`.
   Suggested profile description: “Co-founder & CTO at Zomma. Building
   computer-use agents for financial operations.” Link the full name from the
   Zomma company page, and update existing editable founder/alumni profiles
   where appropriate.
5. Record a baseline after release and compare it after recrawling: indexed
   pages; impressions/clicks for “Cashel Fitzgerald” and “Cashel Zomma”; AI
   referrals; and citations in Bing's supported AI experiences. Treat manual
   ChatGPT searches as spot checks, since answers vary between sessions.

Account-dependent work was not completed by local build validation. Search
Console, Bing, LinkedIn, and Cloudflare require their account sessions. GitHub
already had the correct name and website; the available CLI credential lacks
the user scope needed to update its bio.

The favicon and app icons use the site's `cf.` mark. `public/index.html` owns the
page title, canonical URL, profile metadata, and sharing-card tags; the 1200×630
card is `public/social-card.png`. These assets can be regenerated with
`scripts/generate_brand_assets.py` (its dependencies are listed in the script).

The connecting-node background responds to clicks and taps on the page, with
motion paused for reduced-motion preferences and hidden tabs. The navigation's
sun/moon button switches day and night palettes. It follows the device theme
until a choice is saved locally, and the first paint uses the selected palette.

## Marvin’s live brain

Both the floating robot and the brain section share one request and response
stream. Marvin serves one generation at a time, with two waiting spots and
automatic queue progression. Closing the chat, clicking away from the brain,
scrolling it out of view, or leaving the tab cancels pending and active work.
Opening the view again does not resubmit the cancelled prompt.

Marvin's avatar lives in a body-level overlay above page content, with its click
target following the rendered model. The rest of that overlay passes clicks
through. He can land on visible headings, text, images, links, controls, and
panels throughout the site. Hidden or clipped content is excluded, and perches
are refreshed after scrolling, resizing, image loads, and disclosure changes.
Project cards provide a single top edge, with their contents excluded as perches.
Text perches follow cached raster glyph contours, including lowercase letters;
spaces do not support his feet. The portrait opts into an alpha contour with
separate shoulder and hair ledges, including the shoulders underneath the hair.
Walking uses a smoothed travel curve and gradual weight transfer between the
feet; precise sole contact still uses the original ink and image contours.
Steep ledges use jumps. Marvin uses the walking clip with a small slope lean
and landing bend.
Reduced motion keeps him still between manual drags.

Token tiles show the actual masks and committed token IDs after each
diffusion step, including earlier blocks kept as context. Selecting a token
reveals its ID and exact tokenizer piece. The compact 3D view sits beside the
tokens. An overview connects token embeddings, all 28 selectable transformer
blocks, the final norm, and the LM output head. The selected block expands into
Q/K/V projections, grouped-query attention, two residual paths, and the SwiGLU
MLP. Hovering a head highlights its shared K/V group; each of the eight groups
contains two query heads.

Node color uses measurements from that forward pass: residual RMS for the layer
selector, separate Q/K/V and attention output RMS for each head, and SwiGLU
activation RMS for 32 sampled MLP channels. The overview measures embedding and
final norm RMS per token, plus LM-head RMS over 64 sampled vocabulary logits.
Connections show model structure, not measured attention
weights. One timeline moves the tokens, response, and 3D view together. The
console stays a fixed size while longer token blocks and responses scroll inside.
No activity is simulated. Offline and servers without telemetry display an
unlit architecture with an explicit connection state.

The public model and activation stream run at
https://huggingface.co/spaces/Cashel/diffusion-chatbot. The instrumented backend
is deployed there; the frontend uses it by default. [backend/marvin](backend/marvin/README.md)
contains the model runtime, forward hooks, tests, deployment revision, and a
deployment command that preserves Space metadata and checks its source revision.

For a local instrumented model:

```bash
python -m pip install -r backend/marvin/requirements.txt pytest
PORT=7861 python backend/marvin/app.py
# In another terminal:
REACT_APP_MARVIN_URL=http://127.0.0.1:7861 npm start
```

`REACT_APP_MARVIN_URL` is a build-time override; it defaults to the public Hugging
Face Space. Never put a Hugging Face write token in a frontend environment variable.

## Content

- `src/components/About.js`: current bio and Zomma link.
- `src/data.js`: selected work and expandable project archive.
- `src/marvinContext.js`: shared model URL and portfolio context.
- `src/marvinStream.js`: SSE decoding, queue status, engagement leases, cancellation, and shared state.
- `src/components/TokenFlow.js`: live token blocks and token inspection.
- `src/components/BrainScene.js`: selectable 3D transformer layer and 2D fallback.

Zomma details were checked against https://www.zommalabs.com/ and
https://www.ycombinator.com/companies/zomma on September 5, 2026.
