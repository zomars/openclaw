import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { extensionForMime } from "./mime.js";

export const MEDIA_ARTIFACTS_DIR_NAME = "artifacts";
const ARTIFACT_DIR_MODE = 0o700;
const ARTIFACT_FILE_MODE = 0o600;

function sanitizeArtifactStem(value: string | undefined): string {
  const base = value ? path.basename(value).replace(/\.[^.]*$/u, "") : "media";
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return sanitized.slice(0, 48) || "media";
}

function artifactExtension(params: { contentType?: string; fileName?: string }): string {
  const headerMime = params.contentType?.split(";")[0]?.trim();
  const mimeExt = extensionForMime(headerMime);
  if (mimeExt) {
    return mimeExt.startsWith(".") ? mimeExt.slice(1) : mimeExt;
  }
  const fileExt = params.fileName ? path.extname(params.fileName).replace(/^\./u, "") : "";
  return fileExt || "bin";
}

export function resolveMediaArtifactsDir(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), MEDIA_ARTIFACTS_DIR_NAME);
}

export async function saveMediaArtifact(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  prefix?: string;
}): Promise<{ path: string }> {
  const dir = resolveMediaArtifactsDir();
  await fs.mkdir(dir, { recursive: true, mode: ARTIFACT_DIR_MODE });
  await fs.chmod(dir, ARTIFACT_DIR_MODE).catch(() => {});

  const stem = sanitizeArtifactStem(params.fileName);
  const ext = artifactExtension({ contentType: params.contentType, fileName: params.fileName });
  const prefix = params.prefix?.trim() || "artifact";
  const filePath = path.join(dir, `${prefix}-${stem}-${Date.now()}-${crypto.randomUUID()}.${ext}`);
  await fs.writeFile(filePath, params.buffer, { mode: ARTIFACT_FILE_MODE });
  await fs.chmod(filePath, ARTIFACT_FILE_MODE).catch(() => {});
  return { path: filePath };
}
