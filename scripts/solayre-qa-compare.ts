// Local Solayre QA scorecard comparator.
import fs from "node:fs";
import path from "node:path";
import {
  compareSolayreQaScorecards,
  readSolayreQaScorecard,
  type SolayreQaComparison,
} from "../qa/evals/solayre/scorecard.ts";

type Options = {
  baseline?: string;
  candidate?: string;
  output?: string;
  help: boolean;
};

function usage() {
  return `Usage: pnpm solayre:qa:compare --baseline <scorecard.json> --candidate <scorecard.json> [options]

Options:
  --baseline <path>   Baseline solayre-qa-scorecard.json
  --candidate <path>  Candidate solayre-qa-scorecard.json
  --output <path>     Optional comparison JSON output path
  -h, --help          Display help
`;
}

function parseArgs(args: string[]): Options {
  const opts: Options = { help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }
    for (const key of ["baseline", "candidate", "output"] as const) {
      const inline = arg.startsWith(`--${key}=`) ? arg.slice(key.length + 3) : null;
      if (inline !== null) {
        opts[key] = inline;
        continue;
      }
      if (arg === `--${key}`) {
        opts[key] = args[++index];
        continue;
      }
    }
  }
  return opts;
}

function requirePath(label: string, value: string | undefined) {
  if (!value) {
    throw new Error(`Missing --${label} <path>.`);
  }
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Could not find --${label} file: ${resolved}`);
  }
  return resolved;
}

function renderComparison(comparison: SolayreQaComparison) {
  const lines = [
    `Solayre QA weighted score: ${comparison.baselineScore} -> ${comparison.candidateScore} (${comparison.delta >= 0 ? "+" : ""}${comparison.delta})`,
    `Improved: ${comparison.improved.length}`,
    `Worsened: ${comparison.worsened.length}`,
    `Regressions: ${comparison.regressions.length}`,
  ];
  if (comparison.regressions.length > 0) {
    lines.push("", "Regressions:");
    for (const regression of comparison.regressions) {
      lines.push(`- ${regression.id}: ${regression.reason} (${regression.delta})`);
    }
  }
  if (comparison.worsened.length > 0) {
    lines.push("", "Worsened:");
    for (const worsened of comparison.worsened.slice(0, 10)) {
      lines.push(`- ${worsened.id}: ${worsened.delta}`);
    }
  }
  if (comparison.improved.length > 0) {
    lines.push("", "Improved:");
    for (const improved of comparison.improved.slice(0, 10)) {
      lines.push(`- ${improved.id}: +${improved.delta}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const baselinePath = requirePath("baseline", opts.baseline);
  const candidatePath = requirePath("candidate", opts.candidate);
  const comparison = compareSolayreQaScorecards({
    baseline: readSolayreQaScorecard(baselinePath),
    candidate: readSolayreQaScorecard(candidatePath),
    baselinePath,
    candidatePath,
  });
  process.stdout.write(renderComparison(comparison));
  if (opts.output) {
    const outputPath = path.resolve(opts.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    process.stdout.write(`Comparison JSON: ${outputPath}\n`);
  }
  if (comparison.regressions.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
