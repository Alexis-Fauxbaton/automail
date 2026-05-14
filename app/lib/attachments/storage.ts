import * as fs from "node:fs";
import * as path from "node:path";
import { createId } from "@paralleldrive/cuid2";

export interface Storage {
  save(shop: string, emailId: string, file: File): Promise<{ storagePath: string }>;
  remove(storagePath: string): Promise<void>;
  /**
   * Recursively delete every file stored for a shop. Used by the GDPR
   * shop/redact webhook to purge all attachment files for that tenant.
   * Safe to call when the shop directory does not exist.
   */
  removeShopDir(shop: string): Promise<void>;
  getUrl(storagePath: string): string;
}

// Allowlist of file extensions that are safe to persist on the support
// agent's machine. Executables / scripts are rejected — even if the file
// is only ever served back via api.draft-attachment with forced download,
// preventing storage in the first place is the cleanest defence.
// SVG is excluded — it can contain inline <script> and is an XSS vector if
// ever rendered inline in the admin UI. Customers asking about a product
// rarely send SVGs anyway.
const SAFE_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".csv", ".txt", ".md",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
  ".zip", ".rar", ".7z",
  ".mp3", ".wav", ".mp4", ".mov", ".webm",
  ".eml", ".msg",
]);

export function createStorage(baseDir: string): Storage {
  return {
    async save(shop, emailId, file) {
      const dir = path.join(baseDir, shop, emailId);
      fs.mkdirSync(dir, { recursive: true });

      const rawExt = path.extname(file.name).toLowerCase();
      const isSafeShape = /^\.[a-z0-9]{1,10}$/.test(rawExt);
      const ext = isSafeShape && SAFE_EXTENSIONS.has(rawExt) ? rawExt : "";
      const base = path.basename(file.name, rawExt)
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
      const resolvedBase = path.resolve(baseDir);
      const fullPath = path.resolve(baseDir, storagePath);
      if (!fullPath.startsWith(resolvedBase + path.sep)) {
        throw new Error(`[storage] refusing to remove path outside baseDir: ${storagePath}`);
      }
      try {
        fs.unlinkSync(fullPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },

    async removeShopDir(shop) {
      const resolvedBase = path.resolve(baseDir);
      const fullPath = path.resolve(baseDir, shop);
      if (!fullPath.startsWith(resolvedBase + path.sep)) {
        throw new Error(`[storage] refusing to remove shop dir outside baseDir: ${shop}`);
      }
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
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
