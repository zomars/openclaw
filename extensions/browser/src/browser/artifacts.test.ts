import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tmpDirMocks = vi.hoisted(() => ({
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp/openclaw"),
}));

vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: tmpDirMocks.resolvePreferredOpenClawTmpDir,
}));

const { resolveBrowserArtifactsDir, saveBrowserScreenshotArtifact } =
  await import("./artifacts.js");

describe("browser artifacts", () => {
  beforeEach(() => {
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReset();
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw");
  });

  it("defaults browser screenshot artifacts under the OpenClaw media-allowed temp root", async () => {
    const uniqueRoot = path.join(
      "/tmp",
      `openclaw-browser-artifacts-test-${process.pid}-${Date.now()}`,
    );
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue(uniqueRoot);

    const saved = await saveBrowserScreenshotArtifact({
      buffer: Buffer.from("png"),
      contentType: "image/png",
    });

    expect(resolveBrowserArtifactsDir()).toBe(path.join(uniqueRoot, "artifacts"));
    expect(saved.path).toMatch(
      new RegExp(
        `^${path.join(uniqueRoot, "artifacts").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}${path.sep.replace("\\", "\\\\")}browser-screenshot-.*\\.png$`,
      ),
    );
    await expect(fs.readFile(saved.path, "utf8")).resolves.toBe("png");

    await fs.rm(uniqueRoot, { recursive: true, force: true });
  });
});
