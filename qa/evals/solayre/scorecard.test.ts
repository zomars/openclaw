import { describe, expect, it } from "vitest";
import {
  buildSolayreQaScorecard,
  compareSolayreQaScorecards,
  readSolayreQaScenarioDefinitions,
  type SolayreQaSuiteSummary,
} from "./scorecard.ts";

const baseRun = {
  startedAt: "2026-07-17T00:00:00.000Z",
  finishedAt: "2026-07-17T00:00:01.000Z",
  providerMode: "mock-openai",
  primaryModel: "mock-openai/gpt-5.5",
  alternateModel: "mock-openai/gpt-5.5-alt",
};

function summaryFor(params: {
  id: string;
  name: string;
  status?: "pass" | "fail";
  details?: string;
}): SolayreQaSuiteSummary {
  return {
    run: {
      ...baseRun,
      scenarioIds: [params.id],
    },
    counts: {
      total: 1,
      passed: params.status === "fail" ? 0 : 1,
      failed: params.status === "fail" ? 1 : 0,
    },
    scenarios: [
      {
        name: params.name,
        status: params.status ?? "pass",
        details: "",
        steps: [
          {
            name: "step",
            status: params.status ?? "pass",
            details: params.details ?? "ASSISTANT OpenClaw QA: ok",
          },
        ],
      },
    ],
  };
}

describe("Solayre QA scorecard", () => {
  it("loads all Solayre scenario definitions from yaml and legacy markdown files", () => {
    expect(readSolayreQaScenarioDefinitions().map((scenario) => scenario.id)).toEqual([
      "solayre-coworker-cfe-photo-no-context",
      "solayre-dynamic-quote-url-demo",
      "solayre-handoff-request",
      "solayre-hot-lead-cfe-request",
      "solayre-low-bill-disqualified",
      "solayre-no-receipt-followup",
      "solayre-outside-sinaloa-disqualified",
      "solayre-receipt-before-ownership",
      "solayre-tenant-disqualified",
    ]);
  });

  it("scores present scenarios while keeping absent scenarios visible as missing", () => {
    const scorecard = buildSolayreQaScorecard({
      summary: summaryFor({
        id: "solayre-dynamic-quote-url-demo",
        name: "Solayre dynamic quote URL demo",
      }),
    });

    expect(scorecard.totals.scenarioCount).toBe(9);
    expect(scorecard.totals.scoredScenarioCount).toBe(1);
    expect(scorecard.totals.missing).toBe(8);
    expect(
      scorecard.scenarios.find((scenario) => scenario.id === "solayre-dynamic-quote-url-demo")
        ?.score,
    ).toBe(100);
  });

  it("flags baseline pass to candidate missing as a regression", () => {
    const baseline = buildSolayreQaScorecard({
      summary: summaryFor({
        id: "solayre-coworker-cfe-photo-no-context",
        name: "Solayre coworker CFE photo without client context",
      }),
    });
    const candidate = buildSolayreQaScorecard({
      summary: summaryFor({
        id: "solayre-dynamic-quote-url-demo",
        name: "Solayre dynamic quote URL demo",
      }),
    });

    expect(
      compareSolayreQaScorecards({
        baseline,
        candidate,
        baselinePath: "baseline.json",
        candidatePath: "candidate.json",
      }).regressions,
    ).toContainEqual(
      expect.objectContaining({
        id: "solayre-coworker-cfe-photo-no-context",
      }),
    );
  });
});
