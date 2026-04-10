import type { ImageContent } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import { prepareCliRunContext } from "./cli-runner/prepare.js";
import type { RunCliAgentParams } from "./cli-runner/types.js";
import { FailoverError, isFailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";

export async function runCliAgent(params: RunCliAgentParams): Promise<EmbeddedPiRunResult> {
  const context = await prepareCliRunContext(params);

  const buildCliRunResult = (resultParams: {
    output: Awaited<ReturnType<typeof executePreparedCliRun>>;
    effectiveCliSessionId?: string;
  }): EmbeddedPiRunResult => {
    const text = resultParams.output.text?.trim();
    const payloads = text ? [{ text }] : undefined;

    return {
      payloads,
      meta: {
        durationMs: Date.now() - context.started,
        systemPromptReport: context.systemPromptReport,
        agentMeta: {
          sessionId: resultParams.effectiveCliSessionId ?? params.sessionId ?? "",
          provider: params.provider,
          model: context.modelId,
          usage: resultParams.output.usage,
          ...(resultParams.effectiveCliSessionId
            ? {
                cliSessionBinding: {
                  sessionId: resultParams.effectiveCliSessionId,
                  ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
                },
              }
            : {}),
        },
      },
    };
  };

  // Always try with the stored sessionId. No automatic "session_expired"
  // fallback to a fresh session: the previous fallback was the single
  // biggest source of silent conversation-memory loss — it was triggered
  // by any error message containing "session not found" / "session
  // expired" / etc., which in practice included many transient and
  // misclassified errors, and it threw away a perfectly valid stored
  // sessionId that `claude --resume` would have loaded fine on the next
  // turn. If a resume genuinely fails with an unrecoverable error, let
  // the error propagate; the operator sees it once and can decide
  // whether to reset the binding explicitly. Fail-open on session
  // continuity beats fail-closed amnesia.
  try {
    try {
      const output = await executePreparedCliRun(context, context.reusableCliSession.sessionId);
      const effectiveCliSessionId = output.sessionId ?? context.reusableCliSession.sessionId;
      return buildCliRunResult({ output, effectiveCliSessionId });
    } catch (err) {
      if (isFailoverError(err)) {
        throw err;
      }
      const message = formatErrorMessage(err);
      if (isFailoverErrorMessage(message, { provider: params.provider })) {
        const reason = classifyFailoverReason(message, { provider: params.provider }) ?? "unknown";
        const status = resolveFailoverStatus(reason);
        throw new FailoverError(message, {
          reason,
          provider: params.provider,
          model: context.modelId,
          status,
        });
      }
      throw err;
    }
  } finally {
    await context.preparedBackend.cleanup?.();
  }
}

export async function runClaudeCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  claudeSessionId?: string;
  images?: ImageContent[];
}): Promise<EmbeddedPiRunResult> {
  return runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    cliSessionId: params.claudeSessionId,
    images: params.images,
  });
}
