#!/usr/bin/env node
/**
 * Relay one telemetry event (or an array of them) into the Agent Brain page.
 *
 * Part of the development/orchestration workflow, not the app: agents running
 * inside a Claude session are invisible to Clipper, so whatever is driving that
 * session shells out to this to say what they did. Everything it sends is
 * something that actually happened — this is a pipe, not a generator.
 *
 *   node scripts/telemetry-emit.mjs --port 3000 '{"source":"session",…}'
 *   echo '[{…},{…}]' | node scripts/telemetry-emit.mjs --port 3000
 *
 * The shared secret comes from the file named by --key-file or the
 * TELEMETRY_KEY_FILE environment variable — the same file the server reads.
 * Without it the server answers 501 and nothing is recorded.
 */
import { readFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const port = flag("--port") ?? "3000";
const keyFile = flag("--key-file") ?? process.env.TELEMETRY_KEY_FILE;
if (!keyFile) {
  console.error("no key file: pass --key-file PATH or set TELEMETRY_KEY_FILE");
  process.exit(2);
}

// Everything that is not a flag or a flag's value is the payload.
const consumed = new Set();
for (const name of ["--port", "--key-file"]) {
  const i = argv.indexOf(name);
  if (i !== -1) consumed.add(i).add(i + 1);
}
let payload = argv.filter((_, i) => !consumed.has(i)).join(" ").trim();
if (!payload && !process.stdin.isTTY) {
  payload = "";
  for await (const chunk of process.stdin) payload += chunk;
  payload = payload.trim();
}
if (!payload) {
  console.error('usage: node scripts/telemetry-emit.mjs --port 3000 \'{"source":"session",…}\'');
  process.exit(2);
}

let body;
try {
  body = JSON.parse(payload);
} catch (err) {
  console.error(`payload is not JSON: ${err.message}`);
  process.exit(2);
}

let key;
try {
  key = (await readFile(keyFile, "utf8")).trim();
} catch (err) {
  console.error(`cannot read key file ${keyFile}: ${err.message}`);
  process.exit(2);
}

// Loopback by name: the server rejects anything that did not arrive otherwise.
let res;
try {
  res = await fetch(`http://localhost:${port}/api/telemetry/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telemetry-key": key },
    body: JSON.stringify(body),
  });
} catch (err) {
  // The app not running is the ordinary case for a relay, not a crash: one
  // line, non-zero exit, no stack trace in the orchestrator's log.
  console.error(`cannot reach the app on port ${port}: ${err.message}`);
  process.exit(1);
}
const text = await res.text();
if (!res.ok) {
  console.error(`ingest ${res.status}: ${text.slice(0, 300)}`);
  process.exit(1);
}
process.stdout.write(`${text}\n`);
