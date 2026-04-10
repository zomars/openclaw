import chalk from "chalk";
import {
  formatHealthCheckWarning,
  runCliSessionHealthCheck,
} from "../agents/cli-session-health.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { loadConfig } from "../config/config.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { collectEnabledInsecureOrDangerousFlags } from "../security/dangerous-config-flags.js";

export function logGatewayStartup(params: {
  cfg: ReturnType<typeof loadConfig>;
  bindHost: string;
  bindHosts?: string[];
  port: number;
  pluginCount: number;
  startupStartedAt?: number;
  tlsEnabled?: boolean;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string) => void };
  isNixMode: boolean;
}) {
  const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const modelRef = `${agentProvider}/${agentModel}`;
  params.log.info(`agent model: ${modelRef}`, {
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)}`,
  });
  const startupDurationMs =
    typeof params.startupStartedAt === "number" ? Date.now() - params.startupStartedAt : null;
  const startupDurationLabel =
    startupDurationMs == null ? null : `${(startupDurationMs / 1000).toFixed(1)}s`;
  params.log.info(
    `ready (${params.pluginCount} ${params.pluginCount === 1 ? "plugin" : "plugins"}${startupDurationLabel ? `, ${startupDurationLabel}` : ""})`,
  );
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }

  const enabledDangerousFlags = collectEnabledInsecureOrDangerousFlags(params.cfg);
  if (enabledDangerousFlags.length > 0) {
    const warning =
      `security warning: dangerous config flags enabled: ${enabledDangerousFlags.join(", ")}. ` +
      "Run `openclaw security audit`.";
    params.log.warn(warning);
  }

  // Best-effort canary: walks session stores off-thread and logs a warning
  // if any CLI session binding is pointing at a tiny sessionFile while a
  // much larger historical session exists for the same topic. This is the
  // signal that the old amnesia-class bug fired (or that something else
  // unexpected wiped a binding). Read-only; never blocks startup.
  void runCliSessionHealthCheck()
    .then((result) => {
      const warning = formatHealthCheckWarning(result);
      if (warning) {
        params.log.warn(warning);
      }
    })
    .catch(() => {
      // Health check is opportunistic; failures must not affect boot.
    });
}
