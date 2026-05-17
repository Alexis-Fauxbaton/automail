import * as path from "node:path";
import prisma from "../../db.server";
import { storage } from "./storage";
import { listUploadedFiles, findOrphanPaths, findExpiredPaths } from "./cleanup";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const RETENTION_DAYS = 7;

let ran = false;

export async function runBootCleanup(): Promise<void> {
  const isLeaderWorker = !process.env.WORKER_ID || process.env.WORKER_ID === "0";
  if (!isLeaderWorker) return;
  if (ran) return;
  ran = true;

  try {
    // Cross-shop intentionally: this is a global boot-time scan of the local
    // uploads/ directory. storagePaths are globally unique UUIDs so there is
    // no cross-shop collision risk. Paginate with a cursor so memory stays
    // bounded on a Render-free-tier instance (0.5 CPU + small RAM) even when
    // the DB holds millions of rows.
    const PAGE_SIZE = 500;
    type Row = { id: string; storagePath: string | null; source: string; createdAt: Date };
    const allAttachments: Row[] = [];
    const dbPaths = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await prisma.draftAttachment.findMany({
        where: { source: "upload" },
        select: { id: true, storagePath: true, source: true, createdAt: true },
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (page.length === 0) break;
      for (const a of page) {
        allAttachments.push(a);
        if (a.storagePath) dbPaths.add(a.storagePath);
      }
      cursor = page[page.length - 1].id;
      if (page.length < PAGE_SIZE) break;
    }

    // Orphan scan
    const onDisk = listUploadedFiles(UPLOADS_DIR);
    const orphans = findOrphanPaths(onDisk, dbPaths);
    for (const p of orphans) {
      await storage.remove(p).catch((err: unknown) =>
        console.error("[boot-cleanup] failed to remove orphan:", p, err),
      );
    }
    if (orphans.length > 0) {
      console.log(`[boot-cleanup] removed ${orphans.length} orphan file(s)`);
    }

    // 7-day retention
    const expired = findExpiredPaths(allAttachments, RETENTION_DAYS);
    for (const p of expired) {
      await storage.remove(p).catch((err: unknown) =>
        console.error("[boot-cleanup] failed to remove expired file:", p, err),
      );
    }
    if (expired.length > 0) {
      const expiredIds = allAttachments
        .filter((a) => a.storagePath && expired.includes(a.storagePath))
        .map((a) => a.id);
      await prisma.draftAttachment.deleteMany({ where: { id: { in: expiredIds } } });
      console.log(`[boot-cleanup] purged ${expired.length} expired attachment(s)`);
    }
  } catch (err) {
    console.error("[boot-cleanup] error during boot cleanup:", err);
  }
}
