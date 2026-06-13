import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";

export interface BulkSelectedThread {
  id: string;
  operationalState: string;
  supportNature: string;
  analyzedAt: string | null;
}

type BulkAction = "resolved" | "reopen" | "generate_drafts" | "mark_support";

const CONFIRM_KEY: Record<BulkAction, string> = {
  resolved: "inbox.bulkConfirmResolved",
  reopen: "inbox.bulkConfirmReopen",
  generate_drafts: "inbox.bulkConfirmGenerateDrafts",
  mark_support: "inbox.bulkConfirmMarkSupport",
};

// Scoped styles — kept here so the bar carries its own hover/focus polish
// without depending on a global stylesheet. Colours mirror the app's design
// tokens (ui-slate / ui-emerald) so the bar reads as part of the same system.
const STYLES = `
.bulkbar {
  position: sticky; top: 0; z-index: 5;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 12px; margin-bottom: 4px;
  background: #ffffff;
  border: 1px solid var(--ui-slate-200, #e2e8f0);
  border-radius: 16px;
  box-shadow: var(--ui-shadow-card, 0 8px 24px rgba(15, 23, 42, 0.05));
}
.bulkbar__chip {
  display: inline-flex; align-items: center;
  font-size: 13px; font-weight: 600;
  color: var(--ui-emerald-700, #047857);
  background: var(--ui-emerald-50, #ecfdf5);
  border: 1px solid var(--ui-emerald-200, #a7f3d0);
  border-radius: 999px; padding: 3px 11px;
}
.bulkbar__btn {
  background: #ffffff; color: var(--ui-slate-700, #334155);
  border: 1px solid var(--ui-slate-200, #e2e8f0);
  border-radius: 8px; padding: 5px 11px;
  font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.bulkbar__btn:hover {
  background: var(--ui-slate-50, #f8fafc);
  border-color: var(--ui-slate-400, #94a3b8);
  color: var(--ui-slate-900, #0f172a);
}
.bulkbar__clear {
  margin-left: auto; background: none; border: none;
  color: var(--ui-slate-500, #64748b); font-size: 13px; cursor: pointer;
}
.bulkbar__clear:hover { color: var(--ui-slate-700, #334155); text-decoration: underline; }
.bulkbar-overlay {
  position: fixed; inset: 0; z-index: 50;
  display: flex; align-items: center; justify-content: center;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(2px);
}
.bulkbar-modal {
  background: #ffffff; border-radius: 20px;
  padding: 24px; max-width: 440px; width: 90%;
  box-shadow: var(--ui-shadow-card-strong, 0 12px 30px rgba(15, 23, 42, 0.18));
}
.bulkbar-modal__title {
  font-size: 15px; font-weight: 600; line-height: 1.4;
  color: var(--ui-slate-900, #0f172a); margin: 0 0 12px;
}
.bulkbar-modal__warning {
  display: flex; gap: 8px; align-items: flex-start;
  color: #92400e; background: #fffbeb;
  border: 1px solid #fde68a; border-radius: 10px;
  padding: 10px 12px; font-size: 13px; line-height: 1.45; margin: 0;
}
.bulkbar-modal__actions {
  display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px;
}
.bulkbar-modal__cancel {
  background: #ffffff; color: var(--ui-slate-700, #334155);
  border: 1px solid var(--ui-slate-200, #e2e8f0);
  border-radius: 8px; padding: 7px 14px; font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.bulkbar-modal__cancel:hover:not(:disabled) { background: var(--ui-slate-50, #f8fafc); border-color: var(--ui-slate-400, #94a3b8); }
.bulkbar-modal__confirm {
  background: var(--ui-emerald-700, #047857); color: #ffffff;
  border: none; border-radius: 8px; padding: 7px 16px;
  font-size: 13px; font-weight: 600; cursor: pointer;
  transition: background 0.12s;
}
.bulkbar-modal__confirm:hover:not(:disabled) { background: var(--ui-emerald-600, #059669); }
.bulkbar-modal__cancel:disabled, .bulkbar-modal__confirm:disabled { opacity: 0.6; cursor: default; }
.bulkbar-toast {
  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 60;
  background: var(--ui-slate-900, #0f172a); color: #ffffff;
  padding: 11px 18px; border-radius: 10px; font-size: 13px; font-weight: 500;
  box-shadow: var(--ui-shadow-card-strong, 0 12px 30px rgba(15, 23, 42, 0.18));
}
`;

interface Props {
  selected: BulkSelectedThread[];
  onClear: () => void;
}

export function BulkActionBar({ selected, onClear }: Props) {
  const { t } = useTranslation();
  const fetcher = useFetcher<{ bulkResult?: { updated: number; skipped: number } }>();
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [submittedAction, setSubmittedAction] = useState<BulkAction | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const count = selected.length;
  // "Treat as support" only makes sense when the selection contains threads
  // that aren't support yet — otherwise it would be a no-op for everything.
  const hasNonSupport = selected.some((s) => s.supportNature === "non_support");

  // Generating drafts triggers a first analysis for never-analysed,
  // support-eligible threads — each consumes 1 quota unit. Already-analysed
  // threads regenerate for free, so they don't count toward the warning.
  const analyzeCount = useMemo(() => {
    if (pending !== "generate_drafts") return 0;
    return selected.filter(
      (s) => s.analyzedAt === null && s.supportNature !== "non_support",
    ).length;
  }, [pending, selected]);

  // Show a result toast once the action returns, then clear the selection.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.bulkResult) {
      const { updated, skipped } = fetcher.data.bulkResult;
      let msg: string;
      if (submittedAction === "generate_drafts") {
        // Async: the jobs were queued, drafts surface as they complete.
        msg = t("inbox.bulkToastDraftsQueued", { count: updated });
      } else {
        msg = t("inbox.bulkToastUpdated", { count: updated });
        if (skipped > 0) msg += ` · ${t("inbox.bulkToastSkipped", { count: skipped })}`;
      }
      setToast(msg);
      setPending(null);
      setSubmittedAction(null);
      onClear();
    }
  }, [fetcher.state, fetcher.data, submittedAction, t, onClear]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  if (count === 0 && !toast) return null;

  function submit() {
    if (!pending) return;
    setSubmittedAction(pending);
    fetcher.submit(
      {
        _action: "bulkThreadAction",
        bulkAction: pending,
        threadIds: JSON.stringify(selected.map((s) => s.id)),
      },
      { method: "post" },
    );
  }

  const busy = fetcher.state !== "idle";

  return (
    <>
      <style>{STYLES}</style>

      {count > 0 && (
        <div className="bulkbar">
          <span className="bulkbar__chip">{t("inbox.bulkSelectedCount", { count })}</span>
          <BulkBtn label={t("inbox.bulkMarkResolved")} onClick={() => setPending("resolved")} />
          <BulkBtn label={t("inbox.bulkReopen")} onClick={() => setPending("reopen")} />
          <BulkBtn label={t("inbox.bulkGenerateDrafts")} onClick={() => setPending("generate_drafts")} />
          {hasNonSupport && (
            <BulkBtn label={t("inbox.bulkMarkSupport")} onClick={() => setPending("mark_support")} />
          )}
          <button type="button" className="bulkbar__clear" onClick={onClear}>
            {t("inbox.bulkClear")}
          </button>
        </div>
      )}

      {pending && (
        <div
          className="bulkbar-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => !busy && setPending(null)}
        >
          <div className="bulkbar-modal" onClick={(e) => e.stopPropagation()}>
            <p className="bulkbar-modal__title">{t(CONFIRM_KEY[pending], { count })}</p>
            {analyzeCount > 0 && (
              <p className="bulkbar-modal__warning">
                <span aria-hidden="true">⚠</span>
                <span>{t("inbox.bulkAnalyzeWarning", { count: analyzeCount })}</span>
              </p>
            )}
            <div className="bulkbar-modal__actions">
              <button type="button" className="bulkbar-modal__cancel" onClick={() => setPending(null)} disabled={busy}>
                {t("inbox.bulkCancel")}
              </button>
              <button type="button" className="bulkbar-modal__confirm" onClick={submit} disabled={busy}>
                {t("inbox.bulkConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="bulkbar-toast">{toast}</div>}
    </>
  );
}

function BulkBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="bulkbar__btn" onClick={onClick}>
      {label}
    </button>
  );
}
