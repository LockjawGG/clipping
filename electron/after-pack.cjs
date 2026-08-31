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
