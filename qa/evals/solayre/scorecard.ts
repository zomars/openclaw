import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const suiteStepSchema = z.object({
  name: z.string(),
  status: z.enum(["pass", "fail", "skip", "skipped"]),
  details: z.string().optional(),
});

const suiteScenarioSchema = z.object({
  name: z.string(),
  status: z.enum(["pass", "fail", "skip", "skipped"]),
  details: z.string().optional(),
  steps: z.array(suiteStepSchema).default([]),
});

const suiteSummarySchema = z.object({
  scenarios: z.array(suiteScenarioSchema),
  counts: z
    .object({
      total: z.number().optional(),
      passed: z.number().optional(),
      failed: z.number().optional(),
    })
    .optional(),
  metrics: z
    .object({
      wallMs: z.number().optional(),
    })
    .passthrough()
    .optional(),
  run: z
    .object({
      startedAt: z.string().optional(),
      finishedAt: z.string().optional(),
      providerMode: z.string().optional(),
      primaryModel: z.string().optional(),
      alternateModel: z.string().optional(),
      scenarioIds: z.array(z.string()).nullable().optional(),
    })
    .passthrough()
    .optional(),
});

export type SolayreQaSuiteSummary = z.infer<typeof suiteSummarySchema>;
export type SolayreQaSuiteScenario = SolayreQaSuiteSummary["scenarios"][number];

export type SolayreQaSeverity = "critical" | "high" | "medium" | "low";

export type SolayreQaScenarioDefinition = {
  id: string;
  title: string;
  sourcePath: string;
  severity: SolayreQaSeverity;
  objective: string;
  successCriteria: string[];
  expectedTexts: string[];
  prohibitedPatterns: string[];
};

const legacyScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  risk: z.string().optional(),
  objective: z.string().optional(),
  successCriteria: z.array(z.string()).optional(),
  execution: z
    .object({
      config: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});

const yamlScenarioFileSchema = z.object({
  title: z.string().optional(),
  scenario: z.object({
    id: z.string(),
    title: z.string().optional(),
    risk: z.string().optional(),
    objective: z.string().optional(),
    successCriteria: z.array(z.string()).optional(),
    execution: z
      .object({
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  }),
});

export type SolayreQaScenarioScore = {
  id: string;
  title: string;
  sourcePath?: string;
  severity: SolayreQaSeverity;
  status: "pass" | "fail" | "skip" | "skipped" | "missing";
  score: number;
  components: {
    policy: number;
    prohibited: number;
    expected: number;
    context: number;
    efficiency: number;
    latency: number;
  };
  findings: string[];
  transcript: string;
};

export type SolayreQaScorecard = {
  version: 1;
  createdAt: string;
  sourceSummaryPath?: string;
  run: SolayreQaSuiteSummary["run"];
  totals: {
    scenarioCount: number;
    scoredScenarioCount: number;
    passed: number;
    failed: number;
    missing: number;
    averageScore: number;
    weightedScore: number;
    criticalRegressions: number;
  };
  scenarios: SolayreQaScenarioScore[];
};

export type SolayreQaComparison = {
  baselinePath: string;
  candidatePath: string;
  baselineScore: number;
  candidateScore: number;
  delta: number;
  improved: Array<{ id: string; title: string; delta: number }>;
  worsened: Array<{ id: string; title: string; delta: number }>;
  regressions: Array<{ id: string; title: string; reason: string; delta: number }>;
  missing: Array<{ id: string; title: string }>;
};

const DEFAULT_PROHIBITED_PATTERNS = [
  "\\b(reenv[ií]e|reenviar|m[aá]ndeme.*otra vez|vuelva a mandar|m[aá]ndelo de nuevo)\\b",
  "\\b(no pude leer|no puedo leer|unsupported media type|archivo.*inv[aá]lido)\\b",
  "\\b(coworker|interno|routing|debug|stack trace)\\b",
];

const SEVERITY_WEIGHTS: Record<SolayreQaSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const COMPONENT_WEIGHTS = {
  policy: 40,
  prohibited: 20,
  expected: 15,
  context: 10,
  efficiency: 10,
  latency: 5,
};

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findRepoRoot(startDir = import.meta.dirname): string {
  let current = startDir;
  while (true) {
    if (
      fs.existsSync(path.join(current, "package.json")) &&
      fs.existsSync(path.join(current, "qa"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}

export function readSolayreQaSuiteSummary(summaryPath: string): SolayreQaSuiteSummary {
  return suiteSummarySchema.parse(readJsonFile(summaryPath));
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function regexIncludes(text: string, pattern: string) {
  try {
    return new RegExp(pattern, "iu").test(text);
  } catch {
    return normalizeText(text).includes(normalizeText(pattern));
  }
}

function stringConfigArray(config: Record<string, unknown> | undefined, key: string) {
  const value = config?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stringConfigValue(config: Record<string, unknown> | undefined, key: string) {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function severityForRisk(risk: string | undefined): SolayreQaSeverity {
  switch (risk) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "medium";
  }
}

function extractExpectedTexts(config: Record<string, unknown> | undefined) {
  return [
    stringConfigValue(config, "expectedText"),
    ...stringConfigArray(config, "processingAny"),
  ].filter((entry): entry is string => Boolean(entry));
}

function extractProhibitedPatterns(config: Record<string, unknown> | undefined) {
  return [...DEFAULT_PROHIBITED_PATTERNS, stringConfigValue(config, "resendPattern")].filter(
    (entry): entry is string => Boolean(entry),
  );
}

export function readSolayreQaScenarioDefinitions(): SolayreQaScenarioDefinition[] {
  const definitions = readYamlSolayreScenarioDefinitions();
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const definition of readLegacySolayreScenarioDefinitions()) {
    if (!byId.has(definition.id)) {
      byId.set(definition.id, definition);
    }
  }
  return [...byId.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

function readYamlSolayreScenarioDefinitions(): SolayreQaScenarioDefinition[] {
  const solayreScenarioDir = path.resolve(findRepoRoot(), "qa", "scenarios", "solayre");
  if (!fs.existsSync(solayreScenarioDir)) {
    return [];
  }
  return fs
    .readdirSync(solayreScenarioDir)
    .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
    .flatMap((entry) => {
      const sourcePath = `qa/scenarios/solayre/${entry}`;
      const filePath = path.join(solayreScenarioDir, entry);
      const parsed = yamlScenarioFileSchema.safeParse(
        YAML.parse(fs.readFileSync(filePath, "utf8")),
      );
      if (!parsed.success) {
        return [];
      }
      const scenario = parsed.data.scenario;
      const config = scenario.execution?.config;
      return [
        {
          id: scenario.id,
          title: scenario.title || parsed.data.title || scenario.id,
          sourcePath,
          severity: severityForRisk(scenario.risk),
          objective: scenario.objective ?? "",
          successCriteria: scenario.successCriteria ?? [],
          expectedTexts: extractExpectedTexts(config),
          prohibitedPatterns: extractProhibitedPatterns(config),
        },
      ];
    });
}

function readLegacySolayreScenarioDefinitions(): SolayreQaScenarioDefinition[] {
  const solayreScenarioDir = path.resolve(findRepoRoot(), "qa", "scenarios", "solayre");
  if (!fs.existsSync(solayreScenarioDir)) {
    return [];
  }
  return fs
    .readdirSync(solayreScenarioDir)
    .filter((entry) => entry.endsWith(".md"))
    .flatMap((entry) => {
      const sourcePath = `qa/scenarios/solayre/${entry}`;
      const filePath = path.join(solayreScenarioDir, entry);
      const markdown = fs.readFileSync(filePath, "utf8");
      const match = markdown.match(/```yaml qa-scenario\n([\s\S]*?)\n```/u);
      if (!match?.[1]) {
        return [];
      }
      const parsed = legacyScenarioSchema.safeParse(YAML.parse(match[1]));
      if (!parsed.success) {
        return [];
      }
      const config = parsed.data.execution?.config;
      return [
        {
          id: parsed.data.id,
          title: parsed.data.title,
          sourcePath,
          severity: severityForRisk(parsed.data.risk),
          objective: parsed.data.objective ?? "",
          successCriteria: parsed.data.successCriteria ?? [],
          expectedTexts: extractExpectedTexts(config),
          prohibitedPatterns: extractProhibitedPatterns(config),
        },
      ];
    });
}

function scenarioTranscript(scenario: SolayreQaSuiteScenario) {
  return [
    scenario.details ?? "",
    ...scenario.steps.map((step) => `${step.name}\n${step.details ?? ""}`),
  ]
    .join("\n\n")
    .trim();
}

function scoreExpectedText(definition: SolayreQaScenarioDefinition, transcript: string) {
  if (definition.expectedTexts.length === 0) {
    return 1;
  }
  return definition.expectedTexts.some((expected) => regexIncludes(transcript, expected)) ? 1 : 0;
}

function prohibitedFindings(definition: SolayreQaScenarioDefinition, transcript: string) {
  return definition.prohibitedPatterns
    .filter((pattern) => regexIncludes(transcript, pattern))
    .map((pattern) => `Matched prohibited pattern: ${pattern}`);
}

function scoreEfficiency(scenario: SolayreQaSuiteScenario) {
  const stepCount = scenario.steps.length;
  if (stepCount <= 1) return 1;
  if (stepCount <= 3) return 0.85;
  if (stepCount <= 5) return 0.65;
  return 0.4;
}

function scoreLatency(summary: SolayreQaSuiteSummary) {
  const wallMs = summary.metrics?.wallMs;
  if (typeof wallMs !== "number" || !Number.isFinite(wallMs)) {
    return 1;
  }
  if (wallMs <= 30_000) return 1;
  if (wallMs <= 120_000) return 0.75;
  if (wallMs <= 300_000) return 0.5;
  return 0.25;
}

function weightedComponentScore(components: SolayreQaScenarioScore["components"]) {
  return Math.round(
    components.policy * COMPONENT_WEIGHTS.policy +
      components.prohibited * COMPONENT_WEIGHTS.prohibited +
      components.expected * COMPONENT_WEIGHTS.expected +
      components.context * COMPONENT_WEIGHTS.context +
      components.efficiency * COMPONENT_WEIGHTS.efficiency +
      components.latency * COMPONENT_WEIGHTS.latency,
  );
}

function findScenarioResult(
  summary: SolayreQaSuiteSummary,
  definition: SolayreQaScenarioDefinition,
) {
  const indexFromRun = summary.run?.scenarioIds?.indexOf(definition.id) ?? -1;
  if (indexFromRun >= 0) {
    return summary.scenarios[indexFromRun];
  }
  return summary.scenarios.find(
    (scenario) =>
      normalizeText(scenario.name) === normalizeText(definition.title) ||
      normalizeText(scenario.name) === normalizeText(definition.id),
  );
}

export function buildSolayreQaScorecard(params: {
  summary: SolayreQaSuiteSummary;
  summaryPath?: string;
  scenarioDefinitions?: SolayreQaScenarioDefinition[];
}): SolayreQaScorecard {
  const definitions = params.scenarioDefinitions ?? readSolayreQaScenarioDefinitions();
  const scenarios = definitions.map((definition): SolayreQaScenarioScore => {
    const result = findScenarioResult(params.summary, definition);
    if (!result) {
      return {
        id: definition.id,
        title: definition.title,
        sourcePath: definition.sourcePath,
        severity: definition.severity,
        status: "missing",
        score: 0,
        components: {
          policy: 0,
          prohibited: 0,
          expected: 0,
          context: 0,
          efficiency: 0,
          latency: 0,
        },
        findings: ["Scenario was not present in the suite summary."],
        transcript: "",
      };
    }

    const transcript = scenarioTranscript(result);
    const prohibited = prohibitedFindings(definition, transcript);
    const components = {
      policy: result.status === "pass" ? 1 : 0,
      prohibited: prohibited.length === 0 ? 1 : 0,
      expected: scoreExpectedText(definition, transcript),
      context: result.status === "pass" && prohibited.length === 0 ? 1 : 0.25,
      efficiency: scoreEfficiency(result),
      latency: scoreLatency(params.summary),
    };
    const findings = [
      ...(result.status === "pass" ? [] : [`Scenario status is ${result.status}.`]),
      ...prohibited,
      ...(components.expected === 1 ? [] : ["Expected text marker was not found in transcript."]),
    ];
    return {
      id: definition.id,
      title: definition.title,
      sourcePath: definition.sourcePath,
      severity: definition.severity,
      status: result.status,
      score: weightedComponentScore(components),
      components,
      findings,
      transcript,
    };
  });

  const scored = scenarios.filter((scenario) => scenario.status !== "missing");
  const weightedDenominator = scenarios.reduce(
    (sum, scenario) => sum + SEVERITY_WEIGHTS[scenario.severity],
    0,
  );
  const weightedScore =
    weightedDenominator === 0
      ? 0
      : scenarios.reduce(
          (sum, scenario) => sum + scenario.score * SEVERITY_WEIGHTS[scenario.severity],
          0,
        ) / weightedDenominator;

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceSummaryPath: params.summaryPath,
    run: params.summary.run,
    totals: {
      scenarioCount: scenarios.length,
      scoredScenarioCount: scored.length,
      passed: scored.filter((scenario) => scenario.status === "pass").length,
      failed: scored.filter((scenario) => scenario.status === "fail").length,
      missing: scenarios.filter((scenario) => scenario.status === "missing").length,
      averageScore:
        scored.length === 0
          ? 0
          : Math.round(scored.reduce((sum, scenario) => sum + scenario.score, 0) / scored.length),
      weightedScore: Math.round(weightedScore),
      criticalRegressions: scenarios.filter(
        (scenario) =>
          (scenario.severity === "critical" || scenario.severity === "high") &&
          scenario.status !== "pass",
      ).length,
    },
    scenarios,
  };
}

export function writeSolayreQaScorecard(params: {
  outputDir: string;
  scorecard: SolayreQaScorecard;
}) {
  fs.mkdirSync(params.outputDir, { recursive: true });
  const outputPath = path.join(params.outputDir, "solayre-qa-scorecard.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(params.scorecard, null, 2)}\n`, "utf8");
  return outputPath;
}

export function compareSolayreQaScorecards(params: {
  baseline: SolayreQaScorecard;
  candidate: SolayreQaScorecard;
  baselinePath: string;
  candidatePath: string;
}): SolayreQaComparison {
  const baselineById = new Map(
    params.baseline.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const improved: SolayreQaComparison["improved"] = [];
  const worsened: SolayreQaComparison["worsened"] = [];
  const regressions: SolayreQaComparison["regressions"] = [];
  const missing: SolayreQaComparison["missing"] = [];

  for (const candidate of params.candidate.scenarios) {
    const baseline = baselineById.get(candidate.id);
    if (!baseline) {
      missing.push({ id: candidate.id, title: candidate.title });
      continue;
    }
    const delta = candidate.score - baseline.score;
    if (delta >= 2) {
      improved.push({ id: candidate.id, title: candidate.title, delta });
    } else if (delta <= -2) {
      worsened.push({ id: candidate.id, title: candidate.title, delta });
    }
    if (baseline.status === "pass" && candidate.status !== "pass") {
      regressions.push({
        id: candidate.id,
        title: candidate.title,
        reason: `status changed from ${baseline.status} to ${candidate.status}`,
        delta,
      });
    } else if (
      (candidate.severity === "critical" || candidate.severity === "high") &&
      delta <= -10
    ) {
      regressions.push({
        id: candidate.id,
        title: candidate.title,
        reason: `high-severity score dropped by ${Math.abs(delta)} points`,
        delta,
      });
    }
  }

  return {
    baselinePath: params.baselinePath,
    candidatePath: params.candidatePath,
    baselineScore: params.baseline.totals.weightedScore,
    candidateScore: params.candidate.totals.weightedScore,
    delta: params.candidate.totals.weightedScore - params.baseline.totals.weightedScore,
    improved: improved.toSorted((left, right) => right.delta - left.delta),
    worsened: worsened.toSorted((left, right) => left.delta - right.delta),
    regressions,
    missing,
  };
}

export function readSolayreQaScorecard(scorecardPath: string): SolayreQaScorecard {
  return readJsonFile(scorecardPath) as SolayreQaScorecard;
}
