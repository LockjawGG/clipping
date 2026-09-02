/**
 * Long-running ingest worker. Run alongside `next start`:
 *
 *   npm run worker
 */
import { assertBetaIsolation, betaRoots } from "../src/lib/beta-guard.ts";
import { db } from "../src/lib/db.ts";
import { env } from "../src/lib/env.ts";
import { enqueueJob } from "../src/lib/jobs/prisma-store.ts";
import { createPipelineWorker } from "../src/lib/pipeline/worker-entry.ts";
import { type LiveSweepDb, startLiveSweep } from "../src/lib/pipeline/live-sweep.ts";
import { startTempSweep } from "../src/lib/pipeline/temp-sweep.ts";

// Before the queue is touched. The worker is the process that actually writes
// media and sweeps directories, so a beta pointed at production storage does
// damage here first. A no-op outside the beta; see src/lib/beta-guard.ts.
assertBetaIsolation({
  env: process.env,
  ...betaRoots({
    checkoutRoot: process.cwd(),
    appData: process.env.APPDATA,
    userData: process.env.CLIPPER_USER_DATA,
  }),
  packaged: process.env.CLIPPER_PACKAGED === "1",
});

const worker = createPipelineWorker();
worker.start();
const stopSweep = startTempSweep({ tempDir: env.TEMP_DIR, db });
const stopLiveSweep = startLiveSweep({
  // Same narrowing the service layer uses: the sweep declares only the handful
  // of Prisma calls it makes rather than depending on the generated client.
  db: db as unknown as LiveSweepDb,
  enqueue: (input) => enqueueJob(db, input),
});
console.log("[worker] started; polling the job queue");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received, draining…`);
    stopSweep();
    stopLiveSweep();
    worker.stop().then(() => {
      console.log("[worker] stopped");
      process.exit(0);
    });
  });
}
