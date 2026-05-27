import type { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "../db.server";
import { encryptSessionToken, decryptSessionToken, isEncrypted } from "./session-crypto";

// Wraps PrismaSessionStorage to encrypt accessToken / refreshToken at rest.
//
// The Shopify session storage interface deals in already-deserialised
// `Session` objects, so we mutate the token fields just before delegating
// to the inner storage on writes, and reverse the operation on reads.
//
// Legacy plaintext rows are decrypted as-is (decryptSessionToken returns
// them unchanged), and get re-encrypted the next time Shopify rewrites the
// session — typically the next admin request, since the SDK touches the
// session on every authenticated load.
export class EncryptedPrismaSessionStorage implements SessionStorage {
  private readonly inner: PrismaSessionStorage<typeof prisma>;

  constructor() {
    this.inner = new PrismaSessionStorage(prisma);
  }

  async storeSession(session: Session): Promise<boolean> {
    const encrypted = cloneSession(session);
    if (encrypted.accessToken && !isEncrypted(encrypted.accessToken)) {
      encrypted.accessToken = encryptSessionToken(encrypted.accessToken);
    }
    const refresh = (encrypted as { refreshToken?: string }).refreshToken;
    if (refresh && !isEncrypted(refresh)) {
      (encrypted as { refreshToken?: string }).refreshToken = encryptSessionToken(refresh);
    }
    return this.inner.storeSession(encrypted);
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner.loadSession(id);
    if (!session) return undefined;
    return decryptInPlace(session);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.inner.deleteSession(id);
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    return this.inner.deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.inner.findSessionsByShop(shop);
    return sessions.map(decryptInPlace);
  }
}

// Shallow-clone enough of the Session that mutating the clone's token fields
// doesn't leak back into the caller's object (which they may keep using).
function cloneSession(session: Session): Session {
  // The Session class doesn't expose a clone helper; using Object.assign on
  // a freshly created instance preserves the prototype chain so isActive(),
  // toObject(), etc. continue to work.
  const proto = Object.getPrototypeOf(session) as object | null;
  const clone = Object.create(proto ?? Object.prototype) as Session;
  Object.assign(clone, session);
  return clone;
}

function decryptInPlace(session: Session): Session {
  if (session.accessToken) {
    session.accessToken = decryptSessionToken(session.accessToken);
  }
  const sessionWithRefresh = session as Session & { refreshToken?: string };
  if (sessionWithRefresh.refreshToken) {
    sessionWithRefresh.refreshToken = decryptSessionToken(sessionWithRefresh.refreshToken);
  }
  return session;
}
