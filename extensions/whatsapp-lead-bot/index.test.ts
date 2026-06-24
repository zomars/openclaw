import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRegistrationMode } from "../../src/plugins/types.js";
import plugin from "./index.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-lead-bot-entry-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("whatsapp-lead-bot entrypoint registration modes", () => {
  it.each<PluginRegistrationMode>(["discovery", "setup-only", "setup-runtime", "cli-metadata"])(
    "keeps %s registration side-effect free",
    (registrationMode) => {
      const dir = makeTempDir();
      const dbPath = path.join(dir, "leads.db");
      const registerTool = vi.fn();
      const on = vi.fn();
      const onUnload = vi.fn();
      const api = createTestPluginApi({
        registrationMode,
        pluginConfig: { dbPath },
        registerTool,
        on,
        runtime: { stateDir: dir } as never,
      });
      (api as unknown as { onUnload: typeof onUnload }).onUnload = onUnload;

      plugin.register(api);

      expect(fs.existsSync(dbPath)).toBe(false);
      expect(registerTool).not.toHaveBeenCalled();
      expect(on).not.toHaveBeenCalled();
      expect(onUnload).not.toHaveBeenCalled();
    },
  );

  it("registers lightweight tool stubs during tool discovery without opening the DB", async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "leads.db");
    const registerTool = vi.fn();
    const on = vi.fn();
    const onUnload = vi.fn();
    const api = createTestPluginApi({
      registrationMode: "tool-discovery",
      pluginConfig: { dbPath },
      registerTool,
      on,
      runtime: { stateDir: dir } as never,
    });
    (api as unknown as { onUnload: typeof onUnload }).onUnload = onUnload;

    plugin.register(api);

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(on).not.toHaveBeenCalled();
    expect(onUnload).not.toHaveBeenCalled();
    expect(registerTool).toHaveBeenCalled();

    const firstTool = registerTool.mock.calls[0]?.[0];
    await expect(firstTool.execute("call-1", {})).resolves.toMatchObject({
      details: {
        success: false,
        error: "whatsapp-lead-bot tool execution requires full plugin runtime",
      },
    });
  });
});
