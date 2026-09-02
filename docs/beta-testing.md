# Clipper 1.02 beta — tester checklist

Work top to bottom. Tick a box only when you have seen the thing happen, not
when it looks like it should. Anything unticked is a finding, including "could
not get far enough to try it".

How to record results: copy this file, tick what passed, and under any failed
item write what you did, what you expected, and what happened instead. A
failure report needs the beta's startup log attached:
`%APPDATA%\clipper-102-beta\startup.log` for the packaged app, or the terminal
output of `npm run dev:beta` and `npm run worker:beta` when running from the
checkout. Note the build you tested (the title bar and the pill in the left rail
should both read "Clipper 1.02 beta") — a bug against the wrong build costs more
to chase than it does to file.

Items marked **pending phase N** are not wired yet in this build. Do not report
them as bugs; the box is there so the checklist stays stable as the phases land.
Isolation rules and how to run the beta are in
[`beta-isolation.md`](./beta-isolation.md).

## 1. PROJECT SAFETY

Run this section first, and again after anything unexpected. It is the section
whose failures are unrecoverable.

- [ ] The production Clipper V1.0 exe still launches — how to verify: close the beta, run `Desktop\ClipperV1.0.exe`, and confirm it reaches the dashboard.
- [ ] Existing production projects still open and play — how to verify: in V1.0, open a project made before the beta existed, scrub its clips, confirm video and audio play.
- [ ] The production database is untouched — how to verify: before and after a beta session, note the row counts in the `clipper` database (projects, videos, clips, renders) and confirm they are identical.
- [ ] `%APPDATA%\clipping` is untouched — how to verify: compare a directory listing with timestamps before and after a beta session; nothing under it should have a new modified time.
- [ ] The production `.storage` is untouched — how to verify: same before/after listing of the `.storage` folder inside `C:\Users\Gf788\clipping`.
- [ ] The beta writes only to its own storage — how to verify: after an upload and a render, the new files appear under the beta checkout's `.storage` (or `%APPDATA%\clipper-102-beta\storage` when packaged) and nowhere else.
- [ ] The beta is on its own database — how to verify: the app's data is empty or beta-only on first run, and `DATABASE_URL` in the beta `.env` names `clipper_beta`.
- [ ] The beta runs on port 3100 — how to verify: the dashboard answers at <http://localhost:3100> and nothing new is listening on 3000.
- [ ] The isolation guard actually fires — how to verify: temporarily point `LOCAL_STORAGE_DIR` at a path inside `C:\Users\Gf788\clipping`, start the dev server, confirm it refuses to start with a `BetaIsolationError`, then put the value back.
- [ ] Two launches do not start two copies — how to verify: with the packaged beta running, launch it again; the existing window comes to the front and no second worker or database starts.
- [ ] The 1.01 beta exe is intact — how to verify: `Desktop\Clipper 1.01 Beta Testing.exe` still exists with its original timestamp and still launches.

## 2. EDITING

- [ ] A video ingests end to end — how to verify: upload a file (or add from link), watch it move through probe, transcribe and analyse, and end with clip suggestions.
- [ ] Clip boundaries can be changed and kept — how to verify: adjust a clip's start/end, confirm the preview length changes to match.
- [ ] The timeline edits — how to verify: split at the playhead, move an item, trim an item, delete an item, and confirm the timeline redraws each time.
- [ ] Undo reverses the last timeline edit — how to verify: move or trim an item, press Ctrl+Z, confirm it returns to where it was.
- [ ] Redo re-applies it — how to verify: after an undo, press Ctrl+Shift+Z and confirm the edit comes back.
- [ ] Edits persist across a reload — how to verify: make several edits, wait for saving to settle, reload the page, confirm every edit is still there.
- [ ] Edits persist across a restart — how to verify: quit the app entirely, start it again, reopen the same clip, confirm the state matches.
- [ ] Add an effect to a clip — how to verify: apply an effect from the effect list and see it in the preview. **pending phase 4**
- [ ] Remove or disable an effect — how to verify: delete the instance (or toggle it off) and see the preview return to the unmodified frame. **pending phase 4**
- [ ] Server-side undo/redo of an effect change — how to verify: apply an effect, undo it, reload the page, and confirm the undo survived the reload. **pending phase 3**

## 3. CAPTIONS

- [ ] A transcript is produced — how to verify: after ingest, the clip's transcript panel shows words with timings that line up with the audio.
- [ ] Caption text can be corrected — how to verify: double-click a word, retype it, confirm the change shows in the preview captions.
- [ ] Words can be struck out and the clip closes up — how to verify: strike a word in the middle of a clip, confirm the preview removes it without leaving a gap or a click at the seam.
- [ ] Caption templates apply — how to verify: open the template browser, apply templates from different categories and packs, and confirm the preview restyles each time.
- [ ] A caption style can be saved and reused — how to verify: save the current style under "Mine", apply it to a second clip, confirm it looks the same.
- [ ] Static captions burn in on export — how to verify: render a clip using a non-animated preset and confirm the captions are in the output file, positioned as in the preview.
- [ ] Animated captions render — how to verify: render a clip using an animated preset (word-by-word, karaoke, pop) and confirm the animation appears in the output, not just the preview.
- [ ] Caption edits go through the document model — how to verify: not applicable yet; caption state still writes through its own REST path. **pending phase 5**

## 4. TRANSITIONS

No transition feature ships in this build. These boxes exist so the section is
ready when the phase lands; do not file them as missing features now.

- [ ] A transition can be added between two timeline items — how to verify: select the boundary, add a transition, confirm the preview cross-blends rather than cutting. **pending phase 7**
- [ ] Transition duration is editable — how to verify: change the duration and confirm the blend lengthens or shortens in the preview. **pending phase 7**
- [ ] Transitions survive a split — how to verify: split an item carrying a transition and confirm the transition stays attached to the correct edge. **pending phase 7**
- [ ] Transitions export identically to the preview — how to verify: render the clip and compare the blend to the preview at the same timestamps. **pending phase 7**
- [ ] Meanwhile, cuts are clean — how to verify: with no transition feature in play, confirm a hard cut between two items has no black frame, no audio click and no drift.

## 5. KEYFRAMES

- [ ] A capture window can be keyframed — how to verify: place two capture-window keyframes at different positions and confirm the preview pans between them.
- [ ] Zoom is keyframed too — how to verify: set different zoom values on two keyframes and confirm the preview pushes in or pulls out between them.
- [ ] Easing changes the motion — how to verify: switch a keyframe's easing (linear vs ease out) and confirm the motion between the same two points changes shape.
- [ ] A keyframe can be moved and deleted — how to verify: drag a keyframe to a new time and delete another, confirming the preview updates both times.
- [ ] The keyframed window wins over the static focal point — how to verify: set a focal point, then add capture-window keyframes, and confirm the render follows the keyframes.
- [ ] Keyframes persist — how to verify: reload the page and confirm the keyframes are at the same times with the same values.
- [ ] The export follows the keyframes — how to verify: render the clip and confirm the framing moves the same way as in the preview.
- [ ] Effect parameters can be keyframed — how to verify: add a keyframe on an effect parameter from the inspector and see it animate. **pending phase 4**

## 6. PRESETS

- [ ] Built-in caption templates are all browsable — how to verify: page through both the category and the pack axis and confirm every card renders a preview rather than an empty box.
- [ ] A user preset saves — how to verify: style a clip, save it as a preset, confirm it appears under "Mine".
- [ ] A user preset applies to another clip — how to verify: open a different clip, apply the saved preset, confirm the style matches the original.
- [ ] A user preset can be renamed or deleted — how to verify: rename one and delete another, then reload and confirm both changes stuck.
- [ ] Text-element presets work alongside caption presets — how to verify: save and apply a preset on a text overlay and confirm the two kinds do not appear in each other's list.
- [ ] Zoom / effect presets apply as instances — how to verify: click a zoom preset card and confirm it adds a keyframed effect instance on the clip. **pending phase 4**
- [ ] Applied presets record their provenance — how to verify: after applying, the inspector shows which preset and version the instance came from. **pending phase 4**

## 7. RECIPES

Recipes are multi-step configurations resolved server-side; nothing in this
build implements them.

- [ ] A recipe applies as one batch — how to verify: apply a recipe and confirm it lands as a single undoable step. **pending phase 11**
- [ ] Undo removes the whole recipe — how to verify: apply, undo once, confirm every step it added is gone. **pending phase 11**
- [ ] A recipe is deterministic — how to verify: apply the same recipe twice to identical clips and confirm both produce the same result. **pending phase 11**
- [ ] Recipes appear in the capability catalog — how to verify: `GET /api/edit/catalog` lists them alongside effects and presets. **pending phase 11**

## 8. AI OPERATIONS

- [ ] Clip suggestions are produced — how to verify: after ingest, the suggested clips are sensible spans of the source, not zero-length or whole-video picks.
- [ ] The suggestion worker can be re-run — how to verify: trigger a run from the worker panel and confirm new suggestions arrive and the run reports finished.
- [ ] The assistant panel answers — how to verify: ask it something about the open clip and confirm a reply arrives rather than a spinner that never ends.
- [ ] The local Ollama path is used when available — how to verify: with Ollama running, confirm the assistant status shows it as available and names an installed model.
- [ ] Nothing crashes when the model is absent — how to verify: stop Ollama, retry a suggestion and an assistant message, and confirm the app reports the model as unavailable and falls back (heuristic suggestions) instead of erroring out.
- [ ] Nothing crashes when the model is present but the wrong one — how to verify: point the assistant at a model name that is not installed and confirm the failure is a readable message, not a stuck job.
- [ ] AI edits arrive as ordinary, undoable commands — how to verify: have the assistant apply an edit, then undo it exactly as if you had made it yourself. **pending phase 4**

## 9. RENDERING

- [ ] A render completes — how to verify: request a render and confirm the job reaches a finished state without retries piling up.
- [ ] The output lands in the beta storage — how to verify: the file appears under the beta storage's `renders/<renderId>/output.mp4` and is playable.
- [ ] Nothing is written to production storage during a render — how to verify: check the production `.storage` timestamps before and after; they must be unchanged.
- [ ] The export matches the preview — how to verify: compare framing, caption position and caption timing at the start, middle and end of the clip.
- [ ] Aspect and reframing are correct — how to verify: a 9:16 render is 1080x1920 with the subject inside the frame, not letterboxed content that has been cropped twice.
- [ ] Audio is intact — how to verify: the render's audio is in sync at the end of the clip, with censor spans and any voiceover where the preview had them.
- [ ] Scratch is cleaned up — how to verify: after the render settles, the per-job folder under the beta `TEMP_DIR` is gone.
- [ ] A second render of the same clip is consistent — how to verify: render twice with no edits between and confirm the two outputs have the same duration and look the same.
- [ ] Renders survive a worker restart — how to verify: stop the worker mid-render, start it again, and confirm the job is reclaimed and finishes rather than sitting in PROCESSING forever.
