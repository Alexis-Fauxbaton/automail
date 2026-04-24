import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// We test the real fs in a temp dir
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automail-storage-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

import { createStorage } from "../storage";

describe("createStorage", () => {
  it("save() writes file to expected path and returns relative storagePath", async () => {
    const storage = createStorage(tmpDir);
    const content = Buffer.from("hello pdf");
    const file = new File([content], "invoice.pdf", { type: "application/pdf" });

    const { storagePath } = await storage.save("shop1", "email-abc", file);

    expect(storagePath).toMatch(/^shop1\/email-abc\//);
    expect(storagePath).toMatch(/invoice\.pdf$/);

    const fullPath = path.join(tmpDir, storagePath);
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(fs.readFileSync(fullPath)).toEqual(content);
  });

  it("save() prefixes filename with a cuid to prevent collisions", async () => {
    const storage = createStorage(tmpDir);
    const file = new File(["a"], "doc.pdf", { type: "application/pdf" });
    const { storagePath } = await storage.save("shop1", "email-abc", file);
    const filename = path.basename(storagePath);
    // Format: <cuid>-doc.pdf
    expect(filename).toMatch(/^[a-z0-9]+-doc\.pdf$/);
  });

  it("remove() deletes the file", async () => {
    const storage = createStorage(tmpDir);
    const file = new File(["data"], "f.txt", { type: "text/plain" });
    const { storagePath } = await storage.save("s", "e", file);
    const fullPath = path.join(tmpDir, storagePath);
    expect(fs.existsSync(fullPath)).toBe(true);

    await storage.remove(storagePath);

    expect(fs.existsSync(fullPath)).toBe(false);
  });

  it("remove() does not throw when file does not exist", async () => {
    const storage = createStorage(tmpDir);
    await expect(storage.remove("nonexistent/path/file.pdf")).resolves.not.toThrow();
  });

  it("getUrl() returns a URL using the storagePath", () => {
    const storage = createStorage(tmpDir);
    const url = storage.getUrl("shop1/email-abc/abc123-doc.pdf");
    expect(url).toBe("/uploads/shop1/email-abc/abc123-doc.pdf");
  });
});
