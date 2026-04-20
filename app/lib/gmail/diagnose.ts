/**
 * Diagnostic helper for the mail sync pipeline.
 * Runs a targeted test against the connected mail provider and returns
 * a structured report — no side effects.
 */
import prisma from "../../db.server";
import { createZohoClient, listZohoFoldersRaw } from "../zoho/client";
import { createGmailClient } from "./mail-client";

export interface DiagnosisReport {
  provider: string;
  connectedEmail: string;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
  sampleRecentIds: string[];
  zohoFolders?: Array<{ folderId: string; folderName: string; folderType: string }>;
  sampleMessages?: Array<{
    id: string;
    from: string;
    subject: string;
    labelIds: string[];
    detectedOutgoing: boolean;
  }>;
}

export async function runDiagnosis(shop: string): Promise<DiagnosisReport> {
  const steps: DiagnosisReport["steps"] = [];
  const push = (step: string, ok: boolean, detail: string) =>
    steps.push({ step, ok, detail });

  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn) {
    return {
      provider: "none",
      connectedEmail: "",
      steps: [{ step: "connection", ok: false, detail: "No mail connection" }],
      sampleRecentIds: [],
    };
  }

  const report: DiagnosisReport = {
    provider: conn.provider,
    connectedEmail: conn.email,
    steps,
    sampleRecentIds: [],
    sampleMessages: [],
  };

  try {
    // For Zoho, list raw folders so we can see type + name
    if (conn.provider === "zoho") {
      try {
        const folders = await listZohoFoldersRaw(shop);
        report.zohoFolders = folders;
        push(
          "list_folders",
          true,
          `${folders.length} folders: ${folders.map((f) => `${f.folderName}[${f.folderType}]`).join(", ")}`,
        );
      } catch (err) {
        push(
          "list_folders",
          false,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const client =
      conn.provider === "zoho"
        ? await createZohoClient(shop)
        : await createGmailClient(shop);
    push("create_client", true, `Created ${conn.provider} client`);

    const afterDate = new Date(Date.now() - 30 * 24 * 3600_000);
    const ids = await client.listRecentMessages({ afterDate, maxResults: 20 });
    push(
      "list_recent_messages",
      true,
      `${ids.length} messages from last 30 days (requested 20 max)`,
    );
    report.sampleRecentIds = ids.slice(0, 10);

    if (ids.length === 0) {
      push(
        "fetch_sample",
        false,
        "No messages returned — check mailbox permissions / sent folder detection",
      );
      return report;
    }

    // Sample: first 5 (likely Inbox) + last 5 (likely Sent) to cover both folders
    const sampleIds = [
      ...ids.slice(0, 5),
      ...ids.slice(-5).filter((id) => !ids.slice(0, 5).includes(id)),
    ];

    // Fetch and inspect each sampled message
    const mailbox = conn.email.toLowerCase();
    let outgoingFound = 0;
    for (const id of sampleIds) {
      try {
        const msg = await client.getMessage(id);
        const isOutgoing =
          msg.labelIds.includes("SENT") ||
          msg.from.toLowerCase() === mailbox;
        if (isOutgoing) outgoingFound++;
        report.sampleMessages!.push({
          id: msg.id,
          from: msg.from,
          subject: msg.subject.slice(0, 80),
          labelIds: msg.labelIds,
          detectedOutgoing: isOutgoing,
        });
      } catch (err) {
        push(
          "get_message_error",
          false,
          `Message ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    push(
      "found_outgoing",
      outgoingFound > 0,
      `${outgoingFound}/${report.sampleMessages!.length} tested messages detected as outgoing. Mailbox="${mailbox}". Tested first ${Math.min(5, ids.length)} + last ${Math.min(5, ids.length)} IDs.`,
    );

    // DB check: how many outgoing records already stored?
    const dbOutgoing = await prisma.incomingEmail.count({
      where: { shop, processingStatus: "outgoing" },
    });
    const dbTotal = await prisma.incomingEmail.count({ where: { shop } });
    push(
      "db_outgoing_count",
      true,
      `DB has ${dbOutgoing} outgoing records out of ${dbTotal} total`,
    );
  } catch (err) {
    push(
      "fatal",
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  return report;
}
