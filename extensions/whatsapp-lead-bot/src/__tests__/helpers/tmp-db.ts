import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "../../database/connection.js";

export function createTestDb(): { db: SqliteDatabase; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leadbot-test-"));
  const dbPath = path.join(dir, "test.db");
  const db = new SqliteDatabase({ dbPath });
  db.migrate();
  return { db, dbPath };
}
