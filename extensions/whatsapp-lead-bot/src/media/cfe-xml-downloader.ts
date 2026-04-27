/**
 * Wraps the cfe-recibo-xml Python script (`cfe_download_xml.py`) which downloads
 * the official CFE receipt XML from the public ReciboDeLuzGMX endpoint.
 *
 * Returns the local XML path plus structured fields parsed from the addenda
 * (RPU, total, annual kWh) for use in lead persistence and quote summaries.
 *
 * Used by the composition root to satisfy the `downloadOfficialXml` dependency
 * of process-cfe-receipt. Kept as its own module so tests can fake the Python
 * call without spawning a subprocess.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

const SCRIPT_PATH = path.join(
  os.homedir(),
  ".agents/skills/cfe-recibo-xml/scripts/cfe_download_xml.py",
);
const TIMEOUT_MS = 90_000;

export interface CFEXmlResult {
  xmlPath: string;
  rpu: string;
  nombre: string;
  total?: number;
  annualKwh?: number;
}

export interface CFEXmlDownloader {
  download(input: { rpu: string; nombre: string }): Promise<CFEXmlResult>;
}

interface PythonJsonOutput {
  rpu?: string;
  nombre?: string;
  total?: number;
  annual_kwh?: number;
  xml_path?: string;
}

export function createPythonCfeXmlDownloader(outputDir: string): CFEXmlDownloader {
  return {
    download: ({ rpu, nombre }) =>
      new Promise<CFEXmlResult>((resolve, reject) => {
        if (!/^\d{12}$/.test(rpu)) {
          reject(new Error(`Invalid RPU format: ${rpu}`));
          return;
        }
        if (!nombre.trim()) {
          reject(new Error("Empty nombre"));
          return;
        }

        execFile(
          "python3",
          [SCRIPT_PATH, rpu, nombre.trim(), "-o", outputDir, "--json"],
          { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (stderr) {
              console.log(`[cfe-xml-downloader] ${stderr.trim()}`);
            }
            if (error) {
              reject(new Error(`cfe-xml-downloader failed: ${error.message}`));
              return;
            }
            try {
              const parsed = JSON.parse(stdout.trim()) as PythonJsonOutput;
              if (!parsed.xml_path) {
                reject(new Error("cfe-xml-downloader: no xml_path in output"));
                return;
              }
              resolve({
                xmlPath: parsed.xml_path,
                rpu: parsed.rpu ?? rpu,
                nombre: parsed.nombre ?? nombre,
                total: typeof parsed.total === "number" ? parsed.total : undefined,
                annualKwh: typeof parsed.annual_kwh === "number" ? parsed.annual_kwh : undefined,
              });
            } catch (parseErr) {
              reject(new Error(`cfe-xml-downloader: invalid JSON output: ${String(parseErr)}`));
            }
          },
        );
      }),
  };
}
