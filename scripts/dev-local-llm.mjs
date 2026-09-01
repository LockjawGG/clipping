#!/usr/bin/env node
/**
 * Dev-time delegation pipe to the local Ollama model.
 *
 * Part of the development workflow, not the app: small, self-contained coding
 * subtasks (test fixtures, boilerplate drafts, enumerations) get dispatched to
 * the local model, and the result is reviewed and verified (tsc + tests)
 * before any of it lands. Architecture, pipeline logic and bug fixes stay with
 * the primary engineer; this is for the mechanical middle.
 *
 *   node scripts/dev-local-llm.mjs "prompt"            # answer to stdout
 *   node scripts/dev-local-llm.mjs -m qwen2.5:14b "…"  # pick a model
 *   echo "context" | node scripts/dev-local-llm.mjs "…"  # stdin becomes context
 */

const args = process.argv.slice(2);
let model = "llama3.2";
if (args[0] === "-m") {
  model = args[1];
  args.splice(0, 2);
}
const prompt = args.join(" ").trim();
if (!prompt) {
  console.error("usage: node scripts/dev-local-llm.mjs [-m model] \"prompt\" (stdin = context)");
  process.exit(2);
}

let context = "";
if (!process.stdin.isTTY) {
  for await (const chunk of process.stdin) context += chunk;
}

const res = await fetch("http://127.0.0.1:11434/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You are a precise coding subtask worker. Output ONLY what is asked - " +
          "no preamble, no markdown fences unless asked, no commentary.",
      },
      { role: "user", content: context ? `${prompt}\n\nContext:\n${context}` : prompt },
    ],
  }),
});
if (!res.ok) {
  console.error(`ollama ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const body = await res.json();
process.stdout.write((body.message?.content ?? "") + "\n");
