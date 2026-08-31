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

/** The project root — where package.json, .next and node_modules live. */
const ROOT = path.join(__dirname, "..");

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
function nodeChild(args, extraEnv) {
  return spawn(process.execPath, args, {
    cwd: ROOT,
    // Real environment wins over the file, so a shell override still works.
    env: { ...fileEnv, ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extraEnv },
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
    serverPort = await freePort();
    startServer(serverPort);
    startWorker();

    const up = await waitForServer(serverPort);
    if (!up) throw new Error(`The app server did not answer on port ${serverPort} within 90s.`);

    createWindow(serverPort);
  } catch (err) {
    dialog.showErrorBox("Clipper could not start", String(err?.message ?? err));
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
});
