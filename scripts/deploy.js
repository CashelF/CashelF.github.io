const fs = require("fs");
const path = require("path");
const ghPages = require("gh-pages");
const { execFileSync } = require("child_process");

const build = path.resolve(__dirname, "../build");
if (!fs.existsSync(path.join(build, "index.html")) ||
    fs.readFileSync(path.join(build, "CNAME"), "utf8").trim() !== "cashel.dev") {
  throw new Error("Build the site with its cashel.dev CNAME before deploying.");
}

// Refuse a deploy that would replace the readable pages with an empty app shell.
execFileSync("python3", [path.join(__dirname, "verify-static.py")], { stdio: "inherit" });

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
