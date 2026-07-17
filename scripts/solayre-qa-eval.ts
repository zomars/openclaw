import { spawnSync } from "node:child_process";
// Local Solayre QA scorecard runner.
import fs from "node:fs";
import path from "node:path";
import {
  buildSolayreQaScorecard,
  readSolayreQaSuiteSummary,
  writeSolayreQaScorecard,
} from "../qa/evals/solayre/scorecard.ts";

type Options = {
  summary?: string;
  outputDir?: string;
  skipEvalite: boolean;
  threshold?: string;
  help: boolean;
};

function usage() {
  return `Usage: pnpm solayre:qa:eval [options]

Options:
  --summary <path>       qa-suite-summary.json to score
  --output-dir <path>    Output directory for local artifacts
  --skip-evalite         Only write solayre-qa-scorecard.json
  --threshold <number>   Evalite threshold (0-100)
  -h, --help             Display help
`;
}

function parseArgs(args: string[]): Options {
  const opts: Options = { skipEvalite: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }
    if (arg === "--skip-evalite") {
      opts.skipEvalite = true;
      continue;
    }
    const inlineSummary = arg.startsWith("--summary=") ? arg.slice("--summary=".length) : null;
    if (inlineSummary !== null) {
      opts.summary = inlineSummary;
      continue;
    }
    if (arg === "--summary") {
      opts.summary = args[++index];
      continue;
    }
    const inlineOutput = arg.startsWith("--output-dir=") ? arg.slice("--output-dir=".length) : null;
    if (inlineOutput !== null) {
      opts.outputDir = inlineOutput;
      continue;
    }
    if (arg === "--output-dir") {
      opts.outputDir = args[++index];
      continue;
    }
    const inlineThreshold = arg.startsWith("--threshold=")
      ? arg.slice("--threshold=".length)
      : null;
    if (inlineThreshold !== null) {
      opts.threshold = inlineThreshold;
      continue;
    }
    if (arg === "--threshold") {
      opts.threshold = args[++index];
      continue;
    }
    throw new Error(`Unknown solayre:qa:eval option: ${arg}`);
  }
  return opts;
}

function walkFiles(dir: string, fileName: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, fileName));
    } else if (entry.isFile() && entry.name === fileName) {
      results.push(fullPath);
    }
  }
  return results;
}

function isSolayreSummary(summaryPath: string) {
  try {
    const summary = readSolayreQaSuiteSummary(summaryPath);
    return summary.scenarios.some((scenario) => /solayre/i.test(scenario.name));
  } catch {
    return false;
  }
}

function findLatestSolayreSummary(repoRoot: string) {
  const summaries = walkFiles(path.join(repoRoot, ".artifacts", "qa-e2e"), "qa-suite-summary.json")
    .filter(isSolayreSummary)
    .map((summaryPath) => ({ summaryPath, mtimeMs: fs.statSync(summaryPath).mtimeMs }))
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs);
  return summaries[0]?.summaryPath;
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runEvalite(params: {
  repoRoot: string;
  summaryPath: string;
  outputDir: string;
  threshold?: string;
}) {
  const outputPath = path.join(params.outputDir, "evalite-results.json");
  const evalDir = path.join(params.repoRoot, "qa", "evals", "solayre");
  const evaliteBin = path.join(params.repoRoot, "node_modules", ".bin", "evalite");
  const args = [
    "run",
    "--outputPath",
    outputPath,
    ...(params.threshold ? ["--threshold", params.threshold] : []),
    "solayre-qa.eval.ts",
  ];
  const result = spawnSync(evaliteBin, args, {
    cwd: evalDir,
    env: {
      ...process.env,
      SOLAYRE_QA_SUMMARY_PATH: params.summaryPath,
    },
    encoding: "utf8",
    stdio: "pipe",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(`Evalite failed with exit code ${result.status ?? "unknown"}`);
  }
  return outputPath;
}

const repoRoot = path.resolve(import.meta.dirname, "..");

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const summaryPath = path.resolve(
    repoRoot,
    opts.summary ?? findLatestSolayreSummary(repoRoot) ?? "",
  );
  if (!summaryPath || !fs.existsSync(summaryPath)) {
    throw new Error("No Solayre qa-suite-summary.json found. Pass --summary <path>.");
  }
  const outputDir = path.resolve(
    repoRoot,
    opts.outputDir ?? path.join(".artifacts", "qa-e2e", "solayre-evals", timestampForPath()),
  );
  const summary = readSolayreQaSuiteSummary(summaryPath);
  const scorecard = buildSolayreQaScorecard({ summary, summaryPath });
  const scorecardPath = writeSolayreQaScorecard({ outputDir, scorecard });
  process.stdout.write(`Solayre QA scorecard: ${scorecardPath}\n`);
  process.stdout.write(
    `Solayre QA weighted score: ${scorecard.totals.weightedScore} (${scorecard.totals.passed}/${scorecard.totals.scoredScenarioCount} scored scenarios passed, ${scorecard.totals.missing} missing)\n`,
  );
  if (!opts.skipEvalite) {
    const evalitePath = runEvalite({
      repoRoot,
      summaryPath,
      outputDir,
      threshold: opts.threshold,
    });
    process.stdout.write(`Evalite JSON: ${evalitePath}\n`);
    process.stdout.write(
      `Evalite UI: cd qa/evals/solayre && SOLAYRE_QA_SUMMARY_PATH="${summaryPath}" pnpm exec evalite serve solayre-qa.eval.ts\n`,
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
