// Defines plugin hook registry entry and dispatch types.
import type { HookEntry } from "../hooks/types.js";
import type { PluginHookRegistration as TypedPluginHookRegistration } from "./hook-types.js";

/** Legacy hook registration stored by the global hook runner registry. */
export type PluginLegacyHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
  rootDir?: string;
};

/** Hook runner registry state for legacy and typed plugin hooks. */
export type HookRunnerRegistry = {
  hooks: PluginLegacyHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
};

/** Global hook runner registry snapshot with plugin load status. */
export type GlobalHookRunnerRegistry = HookRunnerRegistry & {
  plugins: Array<{
    id: string;
    status: "loaded" | "disabled" | "error";
    /** From `plugins.entries.<id>.allowAgents`. Used to gate agent-scoped hook dispatch. */
    allowAgents?: string[];
    /** From `plugins.entries.<id>.denyAgents`. Subtractive on top of allowAgents. */
    denyAgents?: string[];
  }>;
};
