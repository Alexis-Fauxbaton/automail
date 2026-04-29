# i18n FR/EN — Design Spec

**Date:** 2026-04-29
**Scope:** Add dynamic French/English language support to the entire app UI

---

## Context

The app currently has hardcoded strings scattered across all routes and components, with an inconsistent mix of French (dashboard) and English (inbox, settings forms, analysis components). No i18n infrastructure exists.

The goal is to unify all user-facing strings under a single i18n system with FR and EN support, selectable per browser session.

---

## Decisions

| Topic | Decision |
|---|---|
| Library | `react-i18next` + `i18next` + `i18next-browser-languagedetector` |
| Language storage | `localStorage` (`i18nextLng` key) — per browser, not per shop |
| Default language | `en` (fallback if no preference stored) |
| Switching UI | `<select>` dropdown in the main nav ([app/routes/app.tsx](app/routes/app.tsx)) |
| Namespace | Single namespace (`common`) — no per-page splitting |
| LLM prompts | **Not translated** — `llm-draft.ts` and `response-draft.ts` templates remain in English; they target the AI model, not the user |
| Draft language | Remains a separate shop-level setting — independent from UI language |

---

## Files to Create

```
app/
  i18n/
    config.ts          ← i18next init: localStorage detection, fallback EN
    locales/
      en.json          ← all English UI strings
      fr.json          ← all French UI strings
```

---

## Translation File Structure

Strings grouped by logical section (not by page — shared strings live in `common`):

```json
{
  "nav": {},
  "inbox": {},
  "support": {},
  "dashboard": {},
  "settings": {},
  "analysis": {},
  "common": {}
}
```

Strings with variables use `react-i18next` interpolation syntax:
```json
"inbox.resultCount": "{{count}} résultat(s)"
```

---

## Initialization

`app/i18n/config.ts` imports and configures `i18next` once:
- detector order: `localStorage`, fallback `en`
- resources: inline imports of `en.json` and `fr.json`

`app/root.tsx` imports `../app/i18n/config` once at the top — no provider wrapper needed (react-i18next v13+ works without it when `initReactI18next` is used).

---

## Language Selector

Location: main nav in [app/routes/app.tsx](app/routes/app.tsx)

```tsx
const { i18n } = useTranslation();
<select value={i18n.language} onChange={e => i18n.changeLanguage(e.target.value)}>
  <option value="fr">Français</option>
  <option value="en">English</option>
</select>
```

- Persisted automatically to `localStorage` on change
- Re-renders the entire UI without page reload
- Visually: small select in the nav bar, no modal, no page redirect

---

## Component Integration Pattern

```tsx
import { useTranslation } from "react-i18next";

export default function SomeComponent() {
  const { t } = useTranslation();
  return <button>{t("inbox.syncNow")}</button>;
}
```

Every hardcoded user-facing string in all routes and components is replaced with a `t()` call.

---

## Coverage Scope

All of the following are translated:

| File | Examples |
|---|---|
| [app/routes/app.tsx](app/routes/app.tsx) | Nav labels, language selector |
| [app/routes/app._index.tsx](app/routes/app._index.tsx) | Home page strings |
| [app/routes/app.inbox.tsx](app/routes/app.inbox.tsx) | Filter labels, buttons, status messages, sync controls |
| [app/routes/app.support.tsx](app/routes/app.support.tsx) | Section headings, form labels, buttons, info text |
| [app/routes/app.dashboard.tsx](app/routes/app.dashboard.tsx) | KPI labels, chart tooltips, state/intent labels, time presets |
| [app/routes/app.settings.tsx](app/routes/app.settings.tsx) | Form labels, tone/language options, section titles |
| [app/routes/auth.login/route.tsx](app/routes/auth.login/route.tsx) | Login form |
| [app/routes/privacy.tsx](app/routes/privacy.tsx) | Privacy policy page |
| [app/components/SupportAnalysisDisplay.tsx](app/components/SupportAnalysisDisplay.tsx) | Card titles, badges, field labels, empty/error states |
| [app/components/ui/index.tsx](app/components/ui/index.tsx) | Shared UI strings if any |
| API error messages in [app/routes/api.reply-draft.tsx](app/routes/api.reply-draft.tsx) etc. | Server returns an error key (e.g. `"error": "method_not_allowed"`); the client component translates it via `t()` — the server never translates directly since locale lives in `localStorage` |

**Not translated:**
- `app/lib/support/llm-draft.ts` — LLM system prompts (English, AI-facing)
- `app/lib/support/response-draft.ts` — Draft templates (already bilingual via `T.en`/`T.fr` — untouched)
- Shopify webhook handlers — server-only, no UI

---

## What Does Not Change

- The `language` field in `SupportSettings` (shop-level draft language) is **not connected** to the UI language selector
- The `T.en` / `T.fr` objects in `response-draft.ts` remain as-is
- LLM prompt construction in `llm-draft.ts` remains in English

---

## Dependencies Added

```
i18next
react-i18next
i18next-browser-languagedetector
```

No other dependencies. No server-side i18n needed.
