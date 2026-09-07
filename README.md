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
CI=true npm test -- --env=node --runInBand
```

The production build is a static site in `build/`; `npm run deploy` publishes it
to this repository’s GitHub Pages branch for `cashel.dev`, preserving the
independently hosted `kd-detr-presentation/` directory.

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
