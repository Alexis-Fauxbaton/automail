/**
 * Central provider dispatch: create a MailClient from a MailConnection.
 *
 * This thin wrapper re-exports the canonical factory (`getMailClient` in
 * `./types`) under the `createMailClient` name so that:
 *  - tests can vi.mock("../../mail/client-factory") without mocking the
 *    whole types module;
 *  - production callers get a stable import path that never changes when
 *    the provider list grows.
 *
 * All token decryption and SDK instantiation lives inside each provider's
 * own adapter (gmail/mail-client.ts, outlook/mail-client.ts, zoho/client.ts).
 */
import type { MailConnection } from "@prisma/client";
import type { MailClient } from "./types";
import { getMailClient } from "./types";

export async function createMailClient(connection: MailConnection): Promise<MailClient> {
  return getMailClient(connection);
}
