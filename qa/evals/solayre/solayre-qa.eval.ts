import { evalite } from "evalite";
import {
  buildSolayreQaScorecard,
  readSolayreQaSuiteSummary,
  type SolayreQaScenarioScore,
} from "./scorecard.ts";

const summaryPath = process.env.SOLAYRE_QA_SUMMARY_PATH;

if (!summaryPath) {
  throw new Error("SOLAYRE_QA_SUMMARY_PATH must point to a qa-suite-summary.json file.");
}

const summary = readSolayreQaSuiteSummary(summaryPath);
const scorecard = buildSolayreQaScorecard({ summary, summaryPath });

evalite<SolayreQaScenarioScore, SolayreQaScenarioScore>("Solayre QA scorecard", {
  data: scorecard.scenarios.map((scenario) => ({ input: scenario })),
  task: async (scenario) => scenario,
  scorers: [
    {
      name: "score",
      description: "Deterministic Solayre scenario score from 0 to 1.",
      scorer: ({ output }) => ({
        score: output.score / 100,
        metadata: output.components,
      }),
    },
    {
      name: "hard-pass",
      description: "Scenario passed and has no blocking findings.",
      scorer: ({ output }) => (output.status === "pass" && output.findings.length === 0 ? 1 : 0),
    },
  ],
  columns: ({ output }) => [
    { label: "Scenario", value: output.id },
    { label: "Severity", value: output.severity },
    { label: "Status", value: output.status },
    { label: "Score", value: output.score },
    { label: "Findings", value: output.findings.join("\n") },
  ],
});
