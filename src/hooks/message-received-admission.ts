import { logVerbose } from "../globals.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  fireAndForgetBoundedHook,
  fireAndForgetHook,
  type FireAndForgetBoundedHookOptions,
} from "./fire-and-forget.js";
import {
  createInternalHookEvent,
  triggerInternalHook,
  type MessageReceivedHookContext,
} from "./internal-hooks.js";
import {
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
  type CanonicalInboundMessageHookContext,
} from "./message-hook-mappers.js";

export type MessageReceivedAdmissionResult = {
  suppressed: boolean;
  suppressReason?: string;
  content?: string;
  pluginHookRan: boolean;
};

export type RunMessageReceivedAdmissionHooksParams = {
  canonical: CanonicalInboundMessageHookContext;
  sessionKey?: string;
  pluginFailureLogLabel: string;
  internalFailureLogLabel: string;
  logger?: (message: string) => void;
  internalHookContext?: Partial<MessageReceivedHookContext>;
  internalHookLimits?: FireAndForgetBoundedHookOptions;
};

export async function runMessageReceivedAdmissionHooks(
  params: RunMessageReceivedAdmissionHooksParams,
): Promise<MessageReceivedAdmissionResult> {
  const logger = params.logger ?? logVerbose;
  const hookRunner = getGlobalHookRunner();
  let result: MessageReceivedAdmissionResult = {
    suppressed: false,
    pluginHookRan: false,
  };

  if (hookRunner?.hasHooks("message_received")) {
    result = {
      ...result,
      pluginHookRan: true,
    };
    const hookResult = await hookRunner
      .runMessageReceived(
        toPluginMessageReceivedEvent(params.canonical),
        toPluginMessageContext(params.canonical),
      )
      .catch((err) => {
        logger(`${params.pluginFailureLogLabel}: ${String(err)}`);
        return undefined;
      });

    if (hookResult?.suppress) {
      result.suppressed = true;
      if (hookResult.suppressReason != null) {
        result.suppressReason = hookResult.suppressReason;
      }
    }
    if (hookResult?.content != null) {
      result.content = hookResult.content;
    }
  }

  const sessionKey = params.sessionKey;
  if (sessionKey) {
    const internalContext = {
      ...toInternalMessageReceivedContext(params.canonical),
      ...params.internalHookContext,
    };
    const task = () =>
      triggerInternalHook(
        createInternalHookEvent("message", "received", sessionKey, internalContext),
      );
    if (params.internalHookLimits) {
      fireAndForgetBoundedHook(
        task,
        params.internalFailureLogLabel,
        undefined,
        params.internalHookLimits,
      );
    } else {
      fireAndForgetHook(task(), params.internalFailureLogLabel);
    }
  }

  return result;
}
