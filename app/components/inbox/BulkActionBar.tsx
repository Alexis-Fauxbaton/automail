import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";

export interface BulkSelectedThread {
  id: string;
  operationalState: string;
  supportNature: string;
  analyzedAt: string | null;
}

type BulkAction =
  | "resolved"
  | "reopen"
  | "waiting_customer"
  | "waiting_merchant"
  | "non_support";

const CONFIRM_KEY: Record<BulkAction, string> = {
  resolved: "inbox.bulkConfirmResolved",
  reopen: "inbox.bulkConfirmReopen",
  waiting_customer: "inbox.bulkConfirmWaitingCustomer",
  waiting_merchant: "inbox.bulkConfirmWaitingMerchant",
  non_support: "inbox.bulkConfirmNonSupport",
};

interface Props {
  selected: BulkSelectedThread[];
  onClear: () => void;
}

export function BulkActionBar({ selected, onClear }: Props) {
  const { t } = useTranslation();
  const fetcher = useFetcher<{ bulkResult?: { updated: number; skipped: number } }>();
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const count = selected.length;

  // Exact "site #2" estimate: only waiting_* moves on threads that will flip
  // (supportNature !== confirmed_support) AND were never analyzed.
  const analyzeCount = useMemo(() => {
    if (pending !== "waiting_customer" && pending !== "waiting_merchant") return 0;
    return selected.filter(
      (s) => s.supportNature !== "confirmed_support" && s.analyzedAt === null,
    ).length;
  }, [pending, selected]);

  // Show a result toast once the action returns, then clear the selection.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.bulkResult) {
      const { updated, skipped } = fetcher.data.bulkResult;
      let msg = t("inbox.bulkToastUpdated", { count: updated });
      if (skipped > 0) msg += ` · ${t("inbox.bulkToastSkipped", { count: skipped })}`;
      setToast(msg);
      setPending(null);
      onClear();
    }
  }, [fetcher.state, fetcher.data, t, onClear]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  if (count === 0 && !toast) return null;

  function submit() {
    if (!pending) return;
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
      {count > 0 && (
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 5,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            padding: "8px 12px",
            marginBottom: 8,
            background: "#1f2937",
            color: "white",
            borderRadius: 8,
          }}
        >
          <strong>{t("inbox.bulkSelectedCount", { count })}</strong>
          <BulkBtn label={t("inbox.bulkMarkResolved")} onClick={() => setPending("resolved")} />
          <BulkBtn label={t("inbox.bulkReopen")} onClick={() => setPending("reopen")} />
          <BulkBtn label={t("inbox.bulkWaitingCustomer")} onClick={() => setPending("waiting_customer")} />
          <BulkBtn label={t("inbox.bulkWaitingMerchant")} onClick={() => setPending("waiting_merchant")} />
          <BulkBtn label={t("inbox.bulkMarkNonSupport")} onClick={() => setPending("non_support")} />
          <button
            type="button"
            onClick={onClear}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "white", cursor: "pointer", textDecoration: "underline" }}
          >
            {t("inbox.bulkClear")}
          </button>
        </div>
      )}

      {pending && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
          onClick={() => !busy && setPending(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "white", borderRadius: 12, padding: 24, maxWidth: 440, width: "90%" }}
          >
            <p style={{ fontWeight: 600, marginBottom: 12 }}>
              {t(CONFIRM_KEY[pending], { count })}
            </p>
            {analyzeCount > 0 && (
              <p style={{ color: "#b45309", background: "#fffbeb", padding: 8, borderRadius: 6, fontSize: 13 }}>
                ⚠ {t("inbox.bulkAnalyzeWarning", { count: analyzeCount })}
              </p>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" onClick={() => setPending(null)} disabled={busy}>
                {t("inbox.bulkCancel")}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                style={{ background: "#047857", color: "white", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer" }}
              >
                {t("inbox.bulkConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#111827",
            color: "white",
            padding: "10px 16px",
            borderRadius: 8,
            zIndex: 60,
          }}
        >
          {toast}
        </div>
      )}
    </>
  );
}

function BulkBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ background: "white", color: "#111827", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 13 }}
    >
      {label}
    </button>
  );
}
