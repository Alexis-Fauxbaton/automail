# Mobile Responsive Design

**Date:** 2026-05-03  
**Branch:** `feat/mobile-responsive`  
**Scope:** Inbox, Dashboard, Settings — full workflow usable on mobile without changing desktop layout.

---

## Context

The app is embedded in the Shopify admin as an iframe. On mobile, Shopify admin collapses its own nav to a hamburger menu — that part works. The app's own UI however has several layout patterns designed for desktop only that break on small viewports (≤ 640px).

Audit performed with Playwright at 375px viewport on the live app.

---

## Problems Identified

### Critical — cause horizontal scroll

1. **Thread detail 2-column panel** (`app.inbox.tsx` ~line 2295)  
   `gridTemplateColumns: "minmax(160px, 220px) minmax(0, 1fr)"` — no mobile breakpoint. Left column forces 220px minimum, causing horizontal overflow on 375px screens.

2. **Thread detail sticky panel** (`app.inbox.tsx` ~line 2715)  
   `position: sticky; maxHeight: calc(100vh - 120px)` — cuts off content on mobile without accounting for the mobile browser chrome.

3. **Thread row tag pills**  
   Pills container wraps but individual pills have `white-space: nowrap` and the row container has no `overflow: hidden` → horizontal scroll.

4. **Search input flex-basis** (`app.inbox.tsx` ~line 1106)  
   `flex: "1 1 220px"` — forces a 220px minimum width on screens < 400px.

### High — poor UX but no overflow

5. **Filter tabs wrap on 2 lines** — 5 tabs (To handle / Waiting / Resolved / Other / All) wrap onto multiple rows in a disordered way.

6. **Stats cards stack individually** — 4 large cards one per row creates excessive vertical scroll. On desktop they sit in a `ui-grid-4`.

### Medium — minor polish

7. **Touch targets** — several buttons (`Sync now`, `Reopen`, action links) are below the 44px minimum touch target height recommended by iOS/Android guidelines.

8. **Padding too large on mobile** — root container `padding: 0 20px 40px`, cards `padding: 20px` — both can be reduced on mobile to gain horizontal space.

---

## Design Decisions

### Approach: CSS responsive classes + targeted JSX changes

Add new responsive utility classes to `tokens.css` and replace the specific inline styles that cause breakage. Desktop layout is untouched — all changes are behind `@media (max-width: 768px)` or `@media (max-width: 640px)`.

No new dependencies. No new routes.

### Thread detail on mobile: full-screen view (option A)

On desktop: clicking a thread opens a sticky panel on the right side of a split layout.

On mobile: clicking a thread replaces the list with a full-screen detail view. A "← Back" button returns to the list. This is the standard iOS/Android navigation pattern and gives the analysis and draft reply the space they need.

**Implementation:** a `selectedThread` state already exists in the inbox. On mobile, when `selectedThread` is set, render only the detail panel (hide the list). The split layout class gets a mobile override that stacks vertically and hides the list column.

---

## Files to Modify

| File | Changes |
|------|---------|
| `app/components/ui/tokens.css` | New classes: `.ui-analysis-grid`, `.ui-tabs-scroll`, `.ui-stats-compact`, `.ui-thread-row`. Mobile overrides for `.ui-card`, `.ui-inbox-root`. |
| `app/routes/app.inbox.tsx` | Replace inline styles with new classes. Add mobile-aware show/hide logic for list vs detail. Back button in detail header on mobile. |
| `app/routes/app.dashboard.tsx` | Minor: hero `minWidth` removal, chart height responsive. |
| `app/routes/app.settings.tsx` | Minor: touch target height on form buttons. |

---

## CSS Changes in Detail

### New class: `.ui-analysis-grid`
```css
.ui-analysis-grid {
  display: grid;
  grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
  gap: 16px;
}

@media (max-width: 768px) {
  .ui-analysis-grid {
    grid-template-columns: 1fr;
  }
}
```

### New class: `.ui-tabs-scroll`
```css
.ui-tabs-scroll {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}

.ui-tabs-scroll::-webkit-scrollbar {
  display: none;
}

.ui-tabs-scroll > * {
  flex-shrink: 0;
  white-space: nowrap;
}
```

### Stats 2×2 grid — modify existing `.ui-grid-4` breakpoint
Instead of a new class, update the existing `@media (max-width: 640px)` rule for `.ui-grid-4` in tokens.css to use 2 columns instead of 1. The stats section uses `.ui-grid-4`, so it gets the compact 2×2 layout automatically on mobile. No `!important` needed.
```css
/* tokens.css — update existing rule */
@media (max-width: 640px) {
  .ui-grid-4 {
    grid-template-columns: 1fr 1fr; /* was: 1 column, now 2×2 for stats */
  }
}
```
Note: this affects all `.ui-grid-4` usages. Verify dashboard metric cards also look good in 2×2.

### Mobile overrides for existing classes
```css
@media (max-width: 640px) {
  .ui-inbox-root {
    padding: 0 12px 24px;
  }
  .ui-card {
    padding: 14px;
  }
}
```

### Thread row overflow fix
```css
.ui-thread-row-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  overflow: hidden;
  max-width: 100%;
}
```

### Touch targets
```css
@media (max-width: 768px) {
  .ui-btn, button, [role="button"] {
    min-height: 44px;
  }
}
```

---

## JSX Changes in Detail

### app.inbox.tsx — mobile full-screen navigation

Add a `useMobile()` hook (reads `window.innerWidth`, listens to resize). Default to `false` to avoid SSR crashes (React Router v7 renders server-side):
```ts
function useMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= breakpoint);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [breakpoint]);
  return isMobile;
}
```

In the inbox render:
```tsx
const isMobile = useMobile();

// Thread list: hide when a thread is selected on mobile
if (isMobile && selectedThread) {
  return <ThreadDetailPanel thread={selectedThread} onBack={() => setSelectedThread(null)} />;
}

// Thread detail panel: add Back button header when on mobile
// <button onClick={onBack}>← Back</button>
```

### app.inbox.tsx — replace broken inline styles

| Current inline style | Replacement |
|---|---|
| `gridTemplateColumns: "minmax(160px, 220px) minmax(0, 1fr)"` | `className="ui-analysis-grid"` |
| `position: "sticky", maxHeight: "calc(100vh - 120px)"` | remove on mobile via CSS class |
| Filter tabs container | `className="ui-tabs-scroll"` |
| Stats grid | add `ui-stats-compact` to existing `ui-grid-4` |
| Thread row tags div | `className="ui-thread-row-tags"` |

---

## Breakpoints Used

| Breakpoint | Usage |
|---|---|
| `max-width: 768px` | Mobile navigation (full-screen detail), analysis grid stack, sticky panel off, touch targets |
| `max-width: 640px` | Stats 2×2 grid, padding reduction, card padding reduction |

---

## What Does NOT Change

- Desktop layout — no rule without a media query changes anything above 768px
- Business logic, loaders, actions, hooks (except the new `useMobile` hook)
- Components in `app/components/ui/index.tsx`
- All API calls, data contracts, confidence model, draft generation

---

## Verification Plan

After implementation, use Playwright at 375px viewport to verify:
1. Inbox list renders without horizontal scroll
2. Clicking a thread shows full-screen detail with ← Back button
3. Back button returns to the list
4. Filter tabs scroll horizontally on one line
5. Stats show as 2×2 grid
6. Dashboard renders without overflow
7. Settings form fields and buttons have adequate touch targets
8. Resize to 1280px — desktop layout unchanged
