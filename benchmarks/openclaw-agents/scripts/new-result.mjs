#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [taskId, modelSlug, run = "1"] = process.argv.slice(2);
if (!taskId || !modelSlug) {
  console.error(
    "Usage: node benchmarks/openclaw-agents/scripts/new-result.mjs <task-id> <model-slug> [run]",
  );
  process.exit(2);
}

const root = process.cwd();
const templatePath = join(root, "benchmarks/openclaw-agents/templates/result.json");
const outDir = join(root, "benchmarks/openclaw-agents/results");
const today = new Date().toISOString().slice(0, 10);
const result = JSON.parse(readFileSync(templatePath, "utf8"));
result.date = today;
result.task_id = taskId;
result.model = modelSlug;
result.run = Number(run);

mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${today}--${taskId}--${modelSlug}--run-${run}.json`);
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(outPath);
