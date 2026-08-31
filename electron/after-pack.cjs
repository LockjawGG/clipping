/**
 * Put the environment file next to the packaged executable.
 *
 * `.env` is deliberately not inside the package — it holds a database password,
 * and the package is a directory anyone can browse. The shell looks for one
 * beside the executable instead, so packing has to place it there.
 *
 * Doing it here rather than by hand because `electron-builder` empties the
 * output directory on every run: without this, the app silently loses its
 * configuration on the next repack and starts failing at the first query.
 */

const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  // A portable build brings its own configuration and must not carry anyone's
  // `.env` — that file holds a database password, and the package is a
  // directory the recipient can browse. Set CLIPPER_PORTABLE=1 for a build you
  // intend to hand to someone else.
  if (process.env.CLIPPER_PORTABLE === "1") {
    console.log("  • portable build — .env deliberately not included");
    scrubBuildPaths(context.appOutDir);
    return;
  }

  const source = path.join(context.packager.projectDir, ".env");
  const target = path.join(context.appOutDir, ".env");

  if (!fs.existsSync(source)) {
    // Not fatal: a build machine may legitimately have no .env, and the app
    // reports a clear configuration error on its own if one is missing.
    console.log("  • no .env to copy — the packaged app will need one beside it");
    return;
  }

  fs.copyFileSync(source, target);
  console.log(`  • .env copied beside the executable  target=${target}`);
};

/**
 * Remove the build machine's identity from the served bundles.
 *
 * Next bakes `resolvedPagePath` — the absolute path of each route's source
 * file — into every server chunk, which puts the builder's Windows username
 * and project layout into anything shared. The value is informational at
 * runtime, so it is rewritten to a neutral root. Both the JSON-escaped form
 * (double backslashes inside string literals) and the plain one are covered.
 */
function scrubBuildPaths(appOutDir) {
  const projectWin = path.resolve(__dirname, ".."); // e.g. C:\Users\<name>\clipping
  const backslash = /\\/g;
  const replacements = [
    // [needle as it appears in file text, neutral replacement]
    // Deepest escaping first: a string embedded in a string doubles again, and
    // replacing the double form inside a quadruple one would mangle it.
    [projectWin.replace(backslash, "\\\\\\\\"), "C:\\\\\\\\app"], // twice-escaped (string in a string)
    [projectWin.replace(backslash, "\\\\"), "C:\\\\app"], // escaped inside JS strings
    [projectWin, "C:\\app"], // raw backslashes
    [projectWin.replace(backslash, "/"), "C:/app"], // forward-slash variant
  ];

  const root = path.join(appOutDir, "resources", "app", ".next");
  let touched = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!/\.(js|json|rsc|meta|html|body)$/.test(entry.name)) continue;
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue; // binary or unreadable — nothing textual to leak here
      }
      let out = text;
      for (const [from, to] of replacements) out = out.split(from).join(to);
      if (out !== text) {
        fs.writeFileSync(file, out, "utf8");
        touched += 1;
      }
    }
  };

  if (fs.existsSync(root)) walk(root);
  console.log(`  • scrubbed build-machine paths from ${touched} built files`);
}
