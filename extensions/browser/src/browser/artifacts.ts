import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

export const BROWSER_ARTIFACTS_DIR_NAME = "artifacts";
const ARTIFACT_DIR_MODE = 0o700;
const ARTIFACT_FILE_MODE = 0o600;

function extensionForBrowserArtifactContentType(contentType: string): "png" | "jpg" {
  return /^image\/jpe?g(?:;|$)/i.test(contentType) ? "jpg" : "png";
}

export function resolveBrowserArtifactsDir(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), BROWSER_ARTIFACTS_DIR_NAME);
}

export async function saveBrowserScreenshotArtifact(params: {
  buffer: Buffer;
  contentType: string;
}): Promise<{ path: string }> {
  const dir = resolveBrowserArtifactsDir();
  await fs.mkdir(dir, { recursive: true, mode: ARTIFACT_DIR_MODE });
  await fs.chmod(dir, ARTIFACT_DIR_MODE).catch(() => {});

  const ext = extensionForBrowserArtifactContentType(params.contentType);
  const filePath = path.join(dir, `browser-screenshot-${Date.now()}-${crypto.randomUUID()}.${ext}`);
  await fs.writeFile(filePath, params.buffer, { mode: ARTIFACT_FILE_MODE });
  await fs.chmod(filePath, ARTIFACT_FILE_MODE).catch(() => {});
  return { path: filePath };
}
