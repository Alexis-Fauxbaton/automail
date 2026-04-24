import * as fs from "node:fs";
import * as path from "node:path";

export function findOrphanPaths(
  onDisk: string[],
  inDb: Set<string>,
): string[] {
  return onDisk.filter((p) => !inDb.has(p));
}

export function findExpiredPaths(
  attachments: Array<{ storagePath: string | null; source: string; createdAt: Date }>,
  maxAgeDays: number,
  now: Date = new Date(),
): string[] {
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);
  return attachments
    .filter((a) => a.source === "upload" && a.storagePath !== null && a.createdAt < cutoff)
    .map((a) => a.storagePath as string);
}

/** Walk uploads/ and collect all leaf file paths relative to baseDir */
export function listUploadedFiles(baseDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        results.push(path.relative(baseDir, full).replace(/\\/g, "/"));
      }
    }
  }

  walk(baseDir);
  return results;
}
