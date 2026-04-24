import { describe, it, expect } from "vitest";
import {
  findOrphanPaths,
  findExpiredPaths,
} from "../cleanup";

describe("findOrphanPaths", () => {
  it("returns paths on disk that have no DB entry", () => {
    const onDisk = [
      "shop1/email-a/abc-doc.pdf",
      "shop1/email-b/xyz-img.png",
      "shop1/email-c/ccc-file.txt",
    ];
    const inDb = new Set([
      "shop1/email-a/abc-doc.pdf",
      "shop1/email-c/ccc-file.txt",
    ]);

    const orphans = findOrphanPaths(onDisk, inDb);

    expect(orphans).toEqual(["shop1/email-b/xyz-img.png"]);
  });

  it("returns empty array when all paths are in DB", () => {
    const onDisk = ["shop1/email-a/file.pdf"];
    const inDb = new Set(["shop1/email-a/file.pdf"]);
    expect(findOrphanPaths(onDisk, inDb)).toEqual([]);
  });
});

describe("findExpiredPaths", () => {
  it("returns upload paths older than maxAgeDays", () => {
    const now = new Date("2026-04-24T12:00:00Z");
    const maxAgeDays = 7;

    const attachments = [
      {
        storagePath: "shop1/email-a/old.pdf",
        source: "upload",
        createdAt: new Date("2026-04-10T00:00:00Z"), // 14 days old
      },
      {
        storagePath: "shop1/email-b/recent.pdf",
        source: "upload",
        createdAt: new Date("2026-04-22T00:00:00Z"), // 2 days old
      },
      {
        storagePath: null,
        source: "thread",
        createdAt: new Date("2026-04-01T00:00:00Z"), // thread attachment — never stored
      },
    ];

    const expired = findExpiredPaths(attachments, maxAgeDays, now);

    expect(expired).toEqual(["shop1/email-a/old.pdf"]);
  });

  it("returns empty array when no attachments are expired", () => {
    const now = new Date("2026-04-24T12:00:00Z");
    const attachments = [
      {
        storagePath: "shop1/email-a/new.pdf",
        source: "upload",
        createdAt: new Date("2026-04-23T00:00:00Z"), // 1 day old
      },
    ];
    expect(findExpiredPaths(attachments, 7, now)).toEqual([]);
  });
});
