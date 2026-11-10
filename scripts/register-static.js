// Reuse the existing Babel toolchain to render the same components as the browser.
require("babel-register")({
  babelrc: false,
  cache: false,
  presets: [["env", { targets: { node: "current" }, modules: "commonjs" }], "react"],
  only: /[\\/]src[\\/]/,
});
