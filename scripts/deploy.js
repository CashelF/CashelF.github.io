const fs = require("fs");
const path = require("path");
const ghPages = require("gh-pages");

const build = path.resolve(__dirname, "../build");
if (!fs.existsSync(path.join(build, "index.html")) ||
    fs.readFileSync(path.join(build, "CNAME"), "utf8").trim() !== "cashel.dev") {
  throw new Error("Build the site with its cashel.dev CNAME before deploying.");
}

ghPages.publish(build, {
  branch: "gh-pages",
  nojekyll: true,
  // This presentation is independently hosted on the same Pages branch.
  remove: ["**/*", "!kd-detr-presentation/**"],
  message: "Deploy cashel.dev",
}, (error) => {
  if (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  console.log("Published cashel.dev to gh-pages.");
});
