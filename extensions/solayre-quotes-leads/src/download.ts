import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DownloadFileDeps {
  apiKey?: string;
}

export function createDownloader(deps: DownloadFileDeps) {
  return async function downloadFile(url: string, destPath: string): Promise<string> {
    const fetchHeaders: Record<string, string> = {};
    if (deps.apiKey && url.includes("supabase.co")) {
      fetchHeaders["X-API-Key"] = deps.apiKey;
    }
    const response = await fetch(url, { headers: fetchHeaders });
    if (!response.ok || !response.body) {
      throw new Error(`downloadFile ${url} → HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      fs.createWriteStream(destPath),
    );
    return destPath;
  };
}
