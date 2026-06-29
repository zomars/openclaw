import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("whatsapp-lead-bot manifest", () => {
  it("loads at gateway startup because message_received admin commands run before agent dispatch", () => {
    const manifestPath = path.resolve(__dirname, "../openclaw.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      activation?: { onStartup?: boolean };
    };

    expect(manifest.activation?.onStartup).toBe(true);
  });
});
