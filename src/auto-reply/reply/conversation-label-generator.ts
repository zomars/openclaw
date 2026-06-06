import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { requireApiKey } from "../../agents/model-auth.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { getRuntimeAuthForModel } from "../../plugins/runtime/runtime-model-auth.runtime.js";

const DEFAULT_MAX_LABEL_LENGTH = 128;
const TIMEOUT_MS = 15_000;

export type ConversationLabelParams = {
  userMessage: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  /** Optional model override for lightweight label generation. Defaults to the routed agent model. */
  model?: string;
  maxLength?: number;
};

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

export async function generateConversationLabel(
  params: ConversationLabelParams,
): Promise<string | null> {
  const { userMessage, prompt, cfg, agentId, agentDir } = params;
  const maxLength =
    typeof params.maxLength === "number" &&
    Number.isFinite(params.maxLength) &&
    params.maxLength > 0
      ? Math.floor(params.maxLength)
      : DEFAULT_MAX_LABEL_LENGTH;
  const defaultModelRef = resolveDefaultModelForAgent({ cfg, agentId });
  const modelOverride = params.model?.trim();
  const modelRef = (() => {
    if (!modelOverride) {
      return defaultModelRef;
    }
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: defaultModelRef.provider });
    const resolvedOverride = resolveModelRefFromString({
      cfg,
      raw: modelOverride,
      defaultProvider: defaultModelRef.provider,
      aliasIndex,
    });
    if (!resolvedOverride) {
      logVerbose(`conversation-label-generator: failed to resolve override model ${modelOverride}`);
      return null;
    }
    return resolvedOverride.ref;
  })();
  if (!modelRef) {
    return null;
  }
  const resolved = await resolveModelAsync(modelRef.provider, modelRef.model, agentDir, cfg);
  if (!resolved.model) {
    logVerbose(
      `conversation-label-generator: failed to resolve model ${modelRef.provider}/${modelRef.model}`,
    );
    return null;
  }
  const completionModel = prepareModelForSimpleCompletion({ model: resolved.model, cfg });

  const apiKey = requireApiKey(
    await getRuntimeAuthForModel({
      model: completionModel,
      cfg,
      workspaceDir: agentDir,
    }),
    modelRef.provider,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const result = await completeSimple(
      completionModel,
      {
        messages: [
          {
            role: "user",
            content: `${prompt}\n\n${userMessage}`,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: 100,
        temperature: 0.3,
        signal: controller.signal,
      },
    );

    const text = result.content
      .filter(isTextContentBlock)
      .map((block) => block.text)
      .join("")
      .trim();

    if (!text) {
      return null;
    }

    return text.slice(0, maxLength);
  } finally {
    clearTimeout(timeout);
  }
}
