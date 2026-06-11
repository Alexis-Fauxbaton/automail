# Send button restyle + optional immediate send — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the inbox « Envoyer » button a polished green look aligned to the app's design tokens, and add a shop-level "immediate send" setting (default off = 5 s safety countdown, on = one-click instant send).

**Architecture:** A new boolean column `immediateSend` on `SupportSettings` (shop-scoped), surfaced in the existing Settings page and threaded through the inbox loader to the `SendButton` component. `SendButton` branches on the flag (instant vs 5 s countdown) and is restyled via CSS classes in the global `tokens.css`. No server-side send logic changes.

**Tech Stack:** TypeScript, React Router 7, Prisma (Postgres), Polaris web components (`s-*`), react-i18next, Vitest (unit + integration).

**Reference spec:** [docs/superpowers/specs/2026-06-11-send-button-restyle-and-immediate-send-design.md](../specs/2026-06-11-send-button-restyle-and-immediate-send-design.md)

**Testing note:** This repo has **no React component test infrastructure** (no testing-library/jsdom). New *logic* is covered by an integration test (settings round-trip) and the existing i18n locale-completeness test. The `SendButton` UI behaviour is verified manually via Playwright on the merchant's store (AMBIENT HOME) — Task 8.

**DB caution:** Per CLAUDE.md, never apply migrations against the prod Neon DB. Apply only against your local/dev/test `DATABASE_URL`.

---

### Task 1: Add `immediateSend` column to `SupportSettings`

**Files:**
- Modify: `prisma/schema.prisma:40-51` (SupportSettings model)
- Create: `prisma/migrations/20260611120000_add_immediate_send/migration.sql`

- [ ] **Step 1: Add the field to the Prisma model**

In `prisma/schema.prisma`, add the `immediateSend` line to the `SupportSettings` model (after `refundPolicy`):

```prisma
model SupportSettings {
  shop                  String   @id
  signatureName         String   @default("Customer Support")
  brandName             String   @default("")
  tone                  String   @default("friendly")     // friendly | formal | neutral
  language              String   @default("auto")         // auto | fr | en
  closingPhrase         String   @default("")
  shareTrackingNumber   Boolean  @default(true)
  customerGreetingStyle String   @default("auto")         // auto | first_name | full_name | neutral
  refundPolicy          String   @default("")
  immediateSend         Boolean  @default(false)          // true = one-click send, no countdown
  updatedAt             DateTime @updatedAt
}
```

- [ ] **Step 2: Hand-write the migration SQL** (matches the repo's manual-migration style)

Create `prisma/migrations/20260611120000_add_immediate_send/migration.sql`:

```sql
-- Add immediateSend to SupportSettings.
-- When true, the inbox « Envoyer » button sends in one click with no
-- countdown. Default false keeps the 5s safety countdown.
ALTER TABLE "SupportSettings" ADD COLUMN "immediateSend" BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 3: Regenerate the Prisma client and apply the migration to the dev/test DB**

Run:
```bash
npx prisma generate
npx prisma migrate deploy
```
Expected: `prisma generate` prints "Generated Prisma Client". `migrate deploy` prints "1 migration found" / "Applying migration `20260611120000_add_immediate_send`" and "All migrations have been successfully applied." (Ensure `DATABASE_URL` points at your dev/test DB, not prod.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no NEW errors (pre-existing `app.inbox.tsx` / script errors tracked in TECHNICAL_DEBT.md are allowed).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260611120000_add_immediate_send/migration.sql
git commit -m "feat(settings): add immediateSend column to SupportSettings"
```

---

### Task 2: Read/write `immediateSend` in `settings.ts` (TDD)

**Files:**
- Modify: `app/lib/support/settings.ts`
- Test: `app/lib/__tests__/integration/settings-immediate-send.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `app/lib/__tests__/integration/settings-immediate-send.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getSettings, saveSettings } from "../../support/settings";
import { resetTestDb, disconnectTestDb, TEST_SHOP } from "./helpers/db";

const baseInput = {
  signatureName: "Support",
  brandName: "Brand",
  tone: "friendly",
  language: "auto",
  closingPhrase: "",
  shareTrackingNumber: true,
  customerGreetingStyle: "auto",
  refundPolicy: "",
};

describe("settings immediateSend", () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("defaults to false when no row exists", async () => {
    const s = await getSettings(TEST_SHOP);
    expect(s.immediateSend).toBe(false);
  });

  it("round-trips true through save and get", async () => {
    await saveSettings(TEST_SHOP, { ...baseInput, immediateSend: true });
    const s = await getSettings(TEST_SHOP);
    expect(s.immediateSend).toBe(true);
  });

  it("round-trips false through save and get", async () => {
    await saveSettings(TEST_SHOP, { ...baseInput, immediateSend: true });
    await saveSettings(TEST_SHOP, { ...baseInput, immediateSend: false });
    const s = await getSettings(TEST_SHOP);
    expect(s.immediateSend).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- settings-immediate-send`
Expected: FAIL — TypeScript error that `immediateSend` does not exist on `SaveSettingsInput` / `SupportSettings` (compile error), or assertion failures.

- [ ] **Step 3: Add `immediateSend` throughout `settings.ts`**

In `app/lib/support/settings.ts` make these four edits:

(a) Add to the `SupportSettings` interface (after `refundPolicy`):
```ts
  /** Free-text refund / return policy shown to the LLM when handling refund requests. */
  refundPolicy: string;
  /** When true, the « Envoyer » button sends in one click with no countdown. */
  immediateSend: boolean;
```

(b) Add to `DEFAULT_SETTINGS` (after `refundPolicy: ""`):
```ts
  refundPolicy: "",
  immediateSend: false,
```

(c) In `getSettings`, the `if (!row)` branch already spreads `DEFAULT_SETTINGS` (covers default). In the mapped return object (after `refundPolicy: row.refundPolicy ?? "",`) add:
```ts
    refundPolicy: row.refundPolicy ?? "",
    immediateSend: row.immediateSend ?? false,
```

(d) Add to `SaveSettingsInput` (after `refundPolicy: string;`):
```ts
  refundPolicy: string;
  immediateSend: boolean;
```

(e) In `saveSettings`, add to the `data` object (after `refundPolicy: input.refundPolicy.trim().slice(0, 2000),`):
```ts
    refundPolicy: input.refundPolicy.trim().slice(0, 2000),
    immediateSend: input.immediateSend,
```

(f) In `saveSettings`, add to the returned object (after `refundPolicy: row.refundPolicy ?? "",`):
```ts
    refundPolicy: row.refundPolicy ?? "",
    immediateSend: row.immediateSend ?? false,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:integration -- settings-immediate-send`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/settings.ts app/lib/__tests__/integration/settings-immediate-send.test.ts
git commit -m "feat(settings): persist immediateSend (get/save round-trip)"
```

---

### Task 3: Add i18n keys for the « Envoi » settings section (TDD via locale-completeness)

**Files:**
- Modify: `app/i18n/locales/en.json`
- Modify: `app/i18n/locales/fr.json`
- Guard test: `app/i18n/__tests__/locale-completeness.test.ts` (already exists; enforces en/fr key parity)

- [ ] **Step 1: Add the English keys**

In `app/i18n/locales/en.json`, inside the `"settings"` object, add these keys right after `"shareTrackingNo"` (line ~170, before `"refundSection"`):

```json
    "shareTrackingNo": "No — hide tracking info (dropshipping)",
    "sendSection": "Sending",
    "sendSectionDesc": "Choose how the « Send » button behaves in the inbox.",
    "immediateSend": "Send behavior",
    "immediateSendDetails": "Immediate sends the reply in one click. The safety delay gives you 5 seconds to cancel before it leaves.",
    "immediateSendOff": "Safety delay before sending (5s)",
    "immediateSendOn": "Send immediately",
    "refundSection": "Refund & return policy",
```

- [ ] **Step 2: Add the French keys (vouvoiement)**

In `app/i18n/locales/fr.json`, inside the `"settings"` object, add the same keys right after `"shareTrackingNo"` (line ~170, before `"refundSection"`):

```json
    "shareTrackingNo": "Non — masquer les infos de suivi (dropshipping)",
    "sendSection": "Envoi",
    "sendSectionDesc": "Choisissez le comportement du bouton « Envoyer » dans la boîte mail.",
    "immediateSend": "Comportement d'envoi",
    "immediateSendDetails": "« Envoi immédiat » envoie la réponse en un clic. Le délai de sécurité vous laisse 5 secondes pour annuler avant le départ.",
    "immediateSendOff": "Délai de sécurité avant envoi (5 s)",
    "immediateSendOn": "Envoi immédiat",
    "refundSection": "Politique de remboursement et retours",
```

- [ ] **Step 3: Run the locale-completeness test**

Run: `npm test -- locale-completeness`
Expected: PASS (2 tests) — en/fr key sets are equal.

- [ ] **Step 4: Commit**

```bash
git add app/i18n/locales/en.json app/i18n/locales/fr.json
git commit -m "i18n: add « Envoi » settings section keys (en/fr)"
```

---

### Task 4: Add the « Envoi » section to the Settings page

**Files:**
- Modify: `app/routes/app.settings.tsx` (action ~line 34-43; UI ~line 196-206 area)

- [ ] **Step 1: Parse `immediateSend` in the action**

In `app/routes/app.settings.tsx`, in the `saveSettings(...)` call inside `action`, add the `immediateSend` field (after `refundPolicy`):

```ts
  const saved = await saveSettings(session.shop, {
    signatureName: String(formData.get("signatureName") ?? ""),
    brandName: String(formData.get("brandName") ?? ""),
    tone: String(formData.get("tone") ?? "friendly"),
    language: String(formData.get("language") ?? "auto"),
    closingPhrase: String(formData.get("closingPhrase") ?? ""),
    shareTrackingNumber: formData.get("shareTrackingNumber") === "true",
    customerGreetingStyle: String(formData.get("customerGreetingStyle") ?? "auto"),
    refundPolicy: String(formData.get("refundPolicy") ?? ""),
    immediateSend: formData.get("immediateSend") === "true",
  });
```

- [ ] **Step 2: Add the « Envoi » UI section**

In the JSX, add a new `<s-section>` immediately after the closing `</s-section>` of the refund section (right before the submit `<s-section>` that contains the save button):

```tsx
          <s-section heading={t("settings.sendSection")}>
            <s-paragraph>{t("settings.sendSectionDesc")}</s-paragraph>

            <s-select
              label={t("settings.immediateSend")}
              name="immediateSend"
              value={settings.immediateSend ? "true" : "false"}
              details={t("settings.immediateSendDetails")}
            >
              <s-option value="false">{t("settings.immediateSendOff")}</s-option>
              <s-option value="true">{t("settings.immediateSendOn")}</s-option>
            </s-select>
          </s-section>
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no NEW errors. (`settings.immediateSend` now exists on the type from Task 2.)

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.settings.tsx
git commit -m "feat(settings): « Envoi » section to toggle immediate send"
```

---

### Task 5: Add the green send-button CSS classes

**Files:**
- Modify: `app/components/ui/tokens.css` (append at end of file)

- [ ] **Step 1: Append the button classes**

At the end of `app/components/ui/tokens.css`, add:

```css

/* ── Inbox « Envoyer » button ──────────────────────────────────────────────
   Custom green action aligned to the Polaris <s-button> neighbours
   (height/corners) since Polaris has no green button tone. */
.am-send-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: var(--ui-emerald-600);
  color: #fff;
  border: 1px solid var(--ui-emerald-600);
  padding: 7px 15px;
  border-radius: 8px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  cursor: pointer;
  text-decoration: none;
}
.am-send-btn:hover {
  background: var(--ui-emerald-700);
  border-color: var(--ui-emerald-700);
}
.am-send-btn:focus-visible {
  outline: 2px solid var(--ui-emerald-700);
  outline-offset: 2px;
}
.am-send-btn:disabled {
  background: #e3e6e8;
  border-color: #e3e6e8;
  color: #9ca3af;
  cursor: not-allowed;
}
/* Neutral variant for the « Activer l'envoi » re-consent link. */
.am-send-btn--reauth {
  background: #fff;
  border-color: #c9cccf;
  color: #1a1a1a;
}
.am-send-btn--reauth:hover {
  background: #f6f6f7;
  border-color: #c9cccf;
}
```

- [ ] **Step 2: Commit**

```bash
git add app/components/ui/tokens.css
git commit -m "feat(inbox): green send-button CSS classes (.am-send-btn)"
```

---

### Task 6: Thread `immediateSend` through the inbox loader

**Files:**
- Modify: `app/routes/app.inbox.tsx` (loader: import + getSettings call + return object ~line 344-370)

- [ ] **Step 1: Import `getSettings`**

In `app/routes/app.inbox.tsx`, add near the other `../lib/support/...` imports at the top of the file:

```ts
import { getSettings } from "../lib/support/settings";
```

- [ ] **Step 2: Load settings in the loader and expose the flag**

In the `loader`, before the final `return {` (around line 344), add:

```ts
  const supportSettings = await getSettings(shop);
```

Then add `immediateSend` to the returned object (after `sendDisabled,`):

```ts
    mailConnectionId: mailConnectionId ?? null,
    sendDisabled,
    immediateSend: supportSettings.immediateSend,
  };
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no NEW errors. `loaderData.immediateSend` is now available (still unused — wired in Task 7).

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(inbox): expose immediateSend from loader"
```

---

### Task 7: Rewrite `SendButton` (green visual, plane icon, 5 s countdown, immediate branch)

**Files:**
- Modify: `app/components/inbox/SendButton.tsx` (full rewrite)
- Modify: `app/routes/app.inbox.tsx` (the `<SendButton ... />` usage ~line 2773-2782)
- Modify: `app/i18n/locales/en.json` + `app/i18n/locales/fr.json` (add `inbox.send.sending`)

- [ ] **Step 1: Add the `inbox.send.sending` i18n key (both locales)**

In `app/i18n/locales/en.json`, inside `"inbox" > "send"`, add after `"sent": "Sent",`:
```json
      "sent": "Sent",
      "sending": "Sending…",
```

In `app/i18n/locales/fr.json`, inside `"inbox" > "send"`, add after `"sent": "Envoyé",`:
```json
      "sent": "Envoyé",
      "sending": "Envoi en cours…",
```

- [ ] **Step 2: Replace the entire contents of `app/components/inbox/SendButton.tsx`**

```tsx
import { useState, useEffect } from "react";
import { useFetcher, Link } from "react-router";
import { useTranslation } from "react-i18next";

type SendState = "idle" | "pending" | "sending" | "sent" | "error" | "needs-reauth";

// Safety countdown for the delayed-send mode. Immediate mode bypasses it.
const COUNTDOWN_MS = 5_000;
const COUNTDOWN_SECONDS = 5;

function PlaneIcon({ color = "#fff" }: { color?: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export default function SendButton(props: {
  shop: string;
  mailConnectionId: string;
  draftId: string;
  customerEmail: string;
  canSend: boolean;
  immediateSend: boolean;
  reauthUrl?: string;
  initialSentAt?: string | null;
  disabled?: boolean;
}) {
  const {
    canSend,
    draftId,
    mailConnectionId,
    customerEmail,
    reauthUrl,
    initialSentAt,
    disabled,
    immediateSend,
  } = props;
  const { t } = useTranslation();
  const fetcher = useFetcher();

  const [state, setState] = useState<SendState>(
    initialSentAt ? "sent" : canSend ? "idle" : "needs-reauth",
  );
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [errorMsg, setErrorMsg] = useState("");

  const actuallySend = () => {
    const fd = new FormData();
    fd.append("intent", "send");
    fd.append("mailConnectionId", mailConnectionId);
    fd.append("draftId", draftId);
    fetcher.submit(fd, { method: "post" });
  };

  // Countdown ticker — only runs in the delayed-send mode (state === "pending").
  useEffect(() => {
    if (state !== "pending") return;
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, COUNTDOWN_MS - elapsed);
      setCountdown(Math.ceil(remaining / 1000));
      if (remaining <= 0) {
        clearInterval(interval);
        actuallySend();
      }
    }, 100);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // React to the send response.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const data = fetcher.data as any;
    if (data.sent) {
      setState("sent");
    } else if (data.needsReauth) {
      setState("needs-reauth");
    } else if (data.error) {
      setState("error");
      setErrorMsg(data.error);
    }
  }, [fetcher.state, fetcher.data]);

  const beginSend = () => {
    if (immediateSend) {
      setState("sending");
      actuallySend();
    } else {
      setCountdown(COUNTDOWN_SECONDS);
      setState("pending");
    }
  };
  const cancelCountdown = () => {
    setState("idle");
  };

  if (disabled) {
    return (
      <button disabled className="am-send-btn" title={t("inbox.send.disabled_no_draft")}>
        <PlaneIcon color="#9ca3af" />
        {t("inbox.send.cta")}
      </button>
    );
  }

  if (state === "needs-reauth") {
    // react-router Link (not native <a>) so navigation stays in the embedded
    // Shopify iframe and preserves shop/host/embedded query params.
    return (
      <Link
        to={reauthUrl ?? `/app/mail-auth/reauth?mailConnectionId=${mailConnectionId}`}
        className="am-send-btn am-send-btn--reauth"
      >
        🔒 {t("inbox.send.activate")}
      </Link>
    );
  }

  if (state === "sent") {
    return (
      <span
        style={{
          color: "var(--ui-emerald-700)",
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        ✓ {t("inbox.send.sent")}
      </span>
    );
  }

  if (state === "sending") {
    return (
      <span style={{ color: "var(--ui-slate-500)", fontWeight: 500 }}>
        {t("inbox.send.sending")}
      </span>
    );
  }

  if (state === "pending") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "7px 12px",
          background: "#eef6ff",
          border: "1px solid #b8d4f5",
          borderRadius: 8,
        }}
      >
        <span>
          ✓ {t("inbox.send.pending", { customer: customerEmail, seconds: countdown })}
        </span>
        <button
          onClick={cancelCountdown}
          style={{
            background: "#fff",
            border: "1px solid #c9cccf",
            color: "#1a1a1a",
            padding: "5px 11px",
            borderRadius: 7,
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 12.5,
          }}
        >
          {t("inbox.send.cancel")}
        </button>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: "#cb2431" }}>⚠ {errorMsg}</span>
        <button onClick={beginSend} className="am-send-btn">
          <PlaneIcon />
          {t("inbox.send.retry")}
        </button>
      </div>
    );
  }

  // idle
  return (
    <button onClick={beginSend} className="am-send-btn">
      <PlaneIcon />
      {t("inbox.send.cta")}
    </button>
  );
}
```

- [ ] **Step 3: Pass `immediateSend` at the call site**

In `app/routes/app.inbox.tsx`, in the `<SendButton ... />` JSX (~line 2773), add the prop:

```tsx
              <SendButton
                shop={loaderData.shop}
                mailConnectionId={connection.id}
                draftId={latest.replyDraftId}
                customerEmail={latest.fromAddress}
                canSend={connection.canSend}
                immediateSend={loaderData.immediateSend}
                reauthUrl={`/app/mail-auth/reauth?mailConnectionId=${connection.id}&returnTo=/app/inbox?thread=${latest.canonicalThreadId ?? ""}`}
                initialSentAt={latest.draftSentAt ?? null}
                disabled={!latest.draftReply}
              />
```

- [ ] **Step 4: Run the locale-completeness test + typecheck**

Run: `npm test -- locale-completeness`
Expected: PASS (the new `inbox.send.sending` key exists in both locales).

Run: `npm run typecheck`
Expected: no NEW errors. (`immediateSend` is now a required prop and is supplied at the only call site.)

- [ ] **Step 5: Commit**

```bash
git add app/components/inbox/SendButton.tsx app/routes/app.inbox.tsx app/i18n/locales/en.json app/i18n/locales/fr.json
git commit -m "feat(inbox): green send button + immediate/5s-countdown send modes"
```

---

### Task 8: Full verification (automated + manual Playwright)

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS (no regressions; locale-completeness included).

- [ ] **Step 2: Run the new integration test**

Run: `npm run test:integration -- settings-immediate-send`
Expected: PASS (3 tests).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no NEW errors beyond the pre-existing ones tracked in TECHNICAL_DEBT.md.

- [ ] **Step 4: Manual Playwright verification on the merchant store**

With the dev server / tunnel running, open the inbox via `https://admin.shopify.com/store/2ed20e/apps/automail-test/app/inbox` (Playwright MCP). Verify:
  1. **Visual** — open a thread that has a draft; the « Envoyer » button is green with a paper-plane icon, same height/corner radius as « Régénérer le brouillon », with a darker-green hover.
  2. **Default (delay) mode** — in Settings, « Envoi » = "Délai de sécurité (5 s)". Click « Envoyer »: a 5-second countdown with « Annuler » appears; click « Annuler » before it elapses → returns to idle. **Do NOT let it actually send** (cancel every time) per the standing instruction not to send real mail.
  3. **Immediate mode** — set Settings « Envoi » = "Envoi immédiat", save, reload the inbox. Click « Envoyer » → it shows "Envoi en cours…" immediately with no countdown. **Do not actually send real mail** — verify the absence of the countdown only (e.g. on a test/internal thread, or stop before confirming the send leaves; if `SEND_DISABLED_FOR_INTERNAL`/`ShopFlag.isInternal` is active the DB flow runs with a fake send and no real mail leaves).
  4. **Disabled state** — a thread with no draft shows a greyed-out « Envoyer ».

- [ ] **Step 5: Final confirmation**

Confirm all automated checks passed and the manual states render correctly. Report results (with command output) before declaring done.

---

## Self-Review

**Spec coverage:**
- Visual green custom button aligned to tokens, plane icon, hover/focus/disabled → Tasks 5 + 7. ✓
- Remove `btnStyle` / inline black styles → Task 7 (full rewrite drops `btnStyle`). ✓
- States idle/needs-reauth/disabled/error/sent/pending/sending → Task 7. ✓
- Shop-level `immediateSend` setting, default false → Tasks 1, 2. ✓
- 5 s countdown (was 10) → Task 7 (`COUNTDOWN_MS = 5_000`). ✓
- Settings UI section « Envoi » with s-select → Tasks 3, 4. ✓
- Loader threads flag to SendButton → Tasks 6, 7. ✓
- No server-side send logic change → confirmed (no task touches the send action/idempotency). ✓
- i18n en/fr parity, vouvoiement → Tasks 3, 7 (guarded by locale-completeness). ✓
- Tests: settings round-trip (integration), locale parity; UI via Playwright → Tasks 2, 3, 8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output. ✓

**Type consistency:** `immediateSend: boolean` used identically across `SupportSettings`, `SaveSettingsInput`, loader return, and `SendButton` props. `beginSend` (not `startCountdown`) is the single click handler used by idle + error states. `COUNTDOWN_MS`/`COUNTDOWN_SECONDS` consistent. ✓
