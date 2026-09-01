/**
 * The desktop shell.
 *
 * The app is a Next.js server, a background worker and a browser talking to
 * both. On the desktop that has to look like one thing you double-click, so
 * this process owns all three: it starts the server, starts the worker, waits
 * until the server actually answers, and only then opens a window at it.
 *
 * Nothing about the app changes. This is a launcher with a window attached —
 * the same server the browser was talking to, addressed from a window that has
 * no address bar.
 */

const { app, BrowserWindow, shell, dialog, Menu } = require("electron");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const { EmbeddedPostgres } = require("./postgres.cjs");

/** The project root — where package.json, .next and node_modules live. */
const ROOT = path.join(__dirname, "..");

/**
 * True when running from the packaged app rather than a checkout.
 *
 * The two want different things: a checkout should keep using the developer's
 * own database and media so `npm run desktop` shows the library they already
 * have, while a packaged copy has to assume the machine has nothing and bring
 * its own.
 */
const PACKAGED = app.isPackaged;

/** Everything the packaged app writes lives under one directory. */
function dataRoot() {
  return app.getPath("userData");
}

let pg = null;

/**
 * Append a line to the app's own startup log.
 *
 * A packaged app has no console to print to: `Start-Process` redirection
 * catches whatever the children write, but anything that fails before the
 * children exist vanishes, and an error dialog on a machine nobody is watching
 * is a hang. So startup narrates itself to a file next to the data it is
 * setting up.
 */
function logStartup(line) {
  try {
    const f = path.join(app.getPath("userData"), "startup.log");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${line}
`, "utf8");
  } catch {
    /* logging must never be the thing that breaks startup */
  }
}

/** Child processes we started, so quitting takes them with us. */
const children = [];
let serverPort = 0;
let win = null;

/** A port nobody is using, so two copies of the app never fight over 3000. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * The `.env` the children need, wherever it is.
 *
 * Next and Prisma both read `.env` from the working directory, which is fine
 * when you run from a checkout. A packaged build deliberately does not contain
 * one — it holds a database password — so it is looked for beside the
 * executable first, then in the project root, and the values are handed to the
 * children directly. Missing is not fatal here: the error the app then shows
 * comes from the config validator, which says which key is wrong.
 */
function loadEnvFile() {
  const candidates = [
    path.join(path.dirname(process.execPath), ".env"),
    path.join(ROOT, ".env"),
  ];
  const found = candidates.find((f) => fs.existsSync(f));
  if (!found) return {};
  const out = {};
  // Split on a newline and let trim() deal with any carriage return -- a
  // regex literal here has been more trouble than the case it covers.
  for (const raw of fs.readFileSync(found, "utf8").split(String.fromCharCode(10))) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // A quoted value ends at its closing quote, so a `#` inside it survives;
    // an unquoted one runs to a trailing ` # comment`. Order matters: strip
    // quotes first and any line with both keeps its quotes.
    if (value.startsWith(String.fromCharCode(34)) || value.startsWith("'")) {
      const quote = value[0];
      const close = value.indexOf(quote, 1);
      if (close > 0) value = value.slice(1, close);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadEnvFile();

/**
 * Configuration for a packaged app, which cannot rely on a `.env` written for
 * somebody's checkout.
 *
 * Paths point inside the app's own data directory so a fresh machine needs no
 * setup, and the database URL is whatever port the embedded server came up on.
 * A checkout gets `{}` and keeps using its `.env` unchanged.
 */
function portableEnv(databaseUrl) {
  if (!PACKAGED) return {};
  const root = dataRoot();
  const res = process.resourcesPath;
  const bin = (...p) => path.join(res, ...p);
  return {
    DATABASE_URL: databaseUrl,
    DATABASE_URL_UNPOOLED: databaseUrl,
    LOCAL_STORAGE_DIR: path.join(root, "storage"),
    TEMP_DIR: path.join(root, "tmp"),
    STORAGE_PROVIDER: "local",
    // Auth needs a stable secret across launches or every restart signs you
    // out. Generated once and kept beside the data it protects.
    NEXTAUTH_SECRET: authSecret(),
    // One machine, one person, loopback only: a sign-in screen guards nothing
    // here and is pure friction. See the flag's note in env.ts.
    DESKTOP_SINGLE_USER: "1",
    // Suggestions try a local Ollama model and fall back to the heuristic
    // scorer per call, so installing Ollama upgrades the app in place.
    ANALYSIS_PROVIDER: "ollama",
    ...bundledTools(bin),
  };
}

/** A secret generated on first run and reused thereafter. */
function authSecret() {
  const f = path.join(dataRoot(), "auth-secret");
  try {
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
    const v = require("node:crypto").randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, v, "utf8");
    return v;
  } catch {
    // Non-fatal: auth reports a clear configuration error of its own.
    return "";
  }
}

/**
 * Point the media tools at the copies shipped with the app, but only at ones
 * that are actually there. Naming a path that does not exist is worse than
 * leaving the variable unset — unset falls back to PATH, which may well find a
 * working copy, while a wrong path fails with a confusing error.
 */
function bundledTools(bin) {
  const candidates = {
    FFMPEG_PATH: bin("tools", "ffmpeg.exe"),
    FFPROBE_PATH: bin("tools", "ffprobe.exe"),
    YTDLP_PATH: bin("tools", "yt-dlp.exe"),
    // Piper's own release build, not the pip console script — the packaged app
    // cannot assume a Python to hang a shim off.
    PIPER_BINARY: bin("tools", "piper", "piper.exe"),
    PIPER_VOICE_DIR: bin("voices"),
    WHISPER_CPP_BINARY: bin("tools", "whisper", "whisper-cli.exe"),
    // medium over small: accuracy first. On spoken English it fixed a real
    // mishearing small made; on Korean it brought the portable build to parity
    // with the main machine's engine. ~3x slower decode, accepted knowingly.
    WHISPER_CPP_MODEL: bin("tools", "whisper", "ggml-medium.bin"),
    // The Settings tab's backup button shells out to pg_dump; the bundled
    // binaries are the only ones a fresh machine has.
    PG_BIN_DIR: bin("pgsql", "bin"),
  };
  const out = {};
  for (const [k, v] of Object.entries(candidates)) {
    if (fs.existsSync(v)) out[k] = v;
  }
  // Only claim the engine when both halves of it actually shipped. Naming a
  // provider whose binary is missing turns a working fallback into a hard
  // failure at the first transcription.
  if (out.WHISPER_CPP_BINARY && out.WHISPER_CPP_MODEL) {
    out.TRANSCRIPTION_PROVIDER = "whisper-cpp";
  }
  // GPU acceleration pack: a CUDA build of the same whisper-cli dropped into
  // the data directory (~8x on long videos, output verified 99%+ identical -
  // fp16 vs fp32 noise only). Machines without the pack, or without the GPU it
  // needs, keep the bundled CPU build untouched.
  //
  // It is handed over as the *preferred* engine rather than as
  // WHISPER_CPP_BINARY, leaving the bundled CPU build in place underneath it.
  // The pack is user-installed and unversioned, so a driver update or a
  // half-deleted directory can break it long after it was working; overriding
  // the only binary would turn that into a hard failure on every transcription,
  // where preferring it degrades to CPU instead.
  const gpuWhisper = path.join(dataRoot(), "gpu-whisper", "whisper-cli.exe");
  if (out.TRANSCRIPTION_PROVIDER === "whisper-cpp" && fs.existsSync(gpuWhisper)) {
    out.WHISPER_CPP_GPU_BINARY = gpuWhisper;
    logStartup(
      `transcription: GPU acceleration pack at ${gpuWhisper} preferred, bundled CPU build as fallback`,
    );
  }
  // A voice *id*, not a path — it cannot go through the exists() filter above,
  // which would silently drop it. Set it only when the file it names shipped.
  if (fs.existsSync(bin("voices", "en_US-lessac-high.onnx"))) {
    out.PIPER_VOICE = "en_US-lessac-high";
  }
  return out;
}

/**
 * Where the app keeps its media on this machine.
 *
 * The same `LOCAL_STORAGE_DIR` the server reads, resolved against the project
 * when it is relative — which is the default. Renders land under `renders/`,
 * one directory per render, so that is what "your renders" means on disk.
 */
function storageDir() {
  const raw = fileEnv.LOCAL_STORAGE_DIR || process.env.LOCAL_STORAGE_DIR || "./.storage";
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

/**
 * Open a folder in Explorer, creating it first if the app has not needed it yet.
 *
 * A menu item that silently does nothing is worse than one that explains
 * itself: a fresh install has no `renders/` until the first export, and
 * `openPath` on a missing directory just fails quietly.
 */
async function revealFolder(dir, label) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  } catch (e) {
    dialog.showErrorBox(`Could not open ${label}`, `${dir}

${e?.message ?? e}`);
  }
}

/**
 * Node's own binary, not whatever `node` resolves to on PATH.
 *
 * A packaged Electron app does not inherit a useful PATH, and the user may not
 * have Node installed at all — Electron bundles one, and `ELECTRON_RUN_AS_NODE`
 * makes it behave like it.
 */
let portable = {};

function nodeChild(args, extraEnv) {
  return spawn(process.execPath, args, {
    cwd: ROOT,
    // Order matters: the packaged app's own paths beat a stale `.env`, but an
    // explicit shell variable still wins over everything for debugging.
    env: {
      ...fileEnv,
      ...portable,
      ...process.env,
      ...(PACKAGED ? portable : {}),
      ELECTRON_RUN_AS_NODE: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** Pipe a child's output to our own, tagged, so a crash is diagnosable. */
function tag(child, name) {
  child.stdout?.on("data", (b) => process.stdout.write(`[${name}] ${b}`));
  child.stderr?.on("data", (b) => process.stderr.write(`[${name}] ${b}`));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) process.stderr.write(`[${name}] exited ${code}\n`);
  });
  children.push(child);
  return child;
}

/**
 * Poll the server until it answers, so the window never opens on a dead port.
 *
 * Addressed as `localhost`, not `127.0.0.1`. They resolve to the same server but
 * are different origins to the cookie jar, and the session cookie is issued for
 * whichever one auth was told about — mix them and every load is signed out.
 */
async function waitForServer(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      }).catch(() => null);
      // Any answer means the server is listening. A 404 is an answer — the
      // route may not exist; what matters is that something replied.
      if (res) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function startServer(port) {
  const next = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(path.join(ROOT, ".next"))) {
    throw new Error(
      "No production build found. Run `npm run build` once before starting the desktop app.",
    );
  }
  const origin = `http://localhost:${port}`;
  return tag(
    nodeChild([next, "start", "--port", String(port)], {
      PORT: String(port),
      // The port is chosen at launch, but `.env` pins NEXTAUTH_URL to :3000 for
      // the browser workflow. Auth builds its redirects from that, so without
      // this the first sign-in redirect points at a port nothing is listening
      // on and the window opens on a connection error.
      NEXTAUTH_URL: origin,
      AUTH_URL: origin,
      AUTH_TRUST_HOST: "true",
    }),
    "server",
  );
}

function startWorker() {
  return tag(nodeChild(["--experimental-strip-types", path.join(ROOT, "scripts", "worker.ts")]), "worker");
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#e3e5e8",
    show: false,
    title: "Clipper",
    webPreferences: {
      // The page is our own server on loopback, but it is still web content:
      // no Node in the renderer, and context isolation on.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    win = null;
  });

  // Anything that is not our own server opens in the real browser, not in a
  // frameless window the user cannot navigate out of.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://localhost:${port}`) && !url.startsWith(`http://127.0.0.1:${port}`)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  void win.loadURL(`http://localhost:${port}/dashboard`);
  return win;
}

/** Reload, devtools and zoom, so the window is not a black box when something breaks. */
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "Open renders folder",
            click: () => void revealFolder(path.join(storageDir(), "renders"), "the renders folder"),
          },
          {
            label: "Open media folder",
            click: () => void revealFolder(storageDir(), "the media folder"),
          },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
}

app.whenReady().then(async () => {
  buildMenu();
  try {
    if (PACKAGED) {
      // The database has to be up before the server or the worker touch it.
      logStartup(`starting: root=${ROOT} resources=${process.resourcesPath}`);
      pg = new EmbeddedPostgres({
        dataDir: path.join(dataRoot(), "pgdata"),
        appRoot: ROOT,
        resourcesPath: process.resourcesPath,
      });
      logStartup(`postgres binaries: ${pg.binDir ?? "NOT FOUND"}`);
      const url = await pg.start();
      logStartup(`postgres ready on port ${pg.port}`);
      portable = portableEnv(url);
      for (const dir of [portable.LOCAL_STORAGE_DIR, portable.TEMP_DIR]) {
        if (dir) fs.mkdirSync(dir, { recursive: true });
      }
    }

    serverPort = await freePort();
    startServer(serverPort);
    startWorker();

    const up = await waitForServer(serverPort);
    if (!up) throw new Error(`The app server did not answer on port ${serverPort} within 90s.`);

    createWindow(serverPort);
  } catch (err) {
    const message = String(err?.stack ?? err?.message ?? err);
    logStartup(`FAILED: ${message}`);
    dialog.showErrorBox(
      "Clipper could not start",
      `${err?.message ?? err}

Details were written to:
${path.join(app.getPath("userData"), "startup.log")}`,
    );
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow(serverPort);
  });
});

/** The window is the app: closing it should not leave a server and a worker behind. */
app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  // After the children: stopping the database first would just give them
  // connection errors on the way out.
  pg?.stop();
});
