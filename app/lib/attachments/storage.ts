import * as fs from "node:fs";
import * as path from "node:path";
import { createId } from "@paralleldrive/cuid2";

export interface Storage {
  save(shop: string, emailId: string, file: File): Promise<{ storagePath: string }>;
  remove(storagePath: string): Promise<void>;
  getUrl(storagePath: string): string;
}

export function createStorage(baseDir: string): Storage {
  return {
    async save(shop, emailId, file) {
      const dir = path.join(baseDir, shop, emailId);
      fs.mkdirSync(dir, { recursive: true });

      const ext = path.extname(file.name);
      const base = path.basename(file.name, ext)
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 60);
      const filename = `${createId()}-${base}${ext}`;
      const fullPath = path.join(dir, filename);

      const buffer = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(fullPath, buffer);

      const storagePath = path.join(shop, emailId, filename).replace(/\\/g, "/");
      return { storagePath };
    },

    async remove(storagePath) {
      const fullPath = path.join(baseDir, storagePath);
      try {
        fs.unlinkSync(fullPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },

    getUrl(storagePath) {
      return `/uploads/${storagePath}`;
    },
  };
}

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
export const storage = createStorage(UPLOADS_DIR);
