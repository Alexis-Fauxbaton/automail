import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORT_INTENTS, type SupportIntent } from "../lib/support/types";
import type { OrderFacts, SupportAnalysis } from "../lib/support/types";

function ChipIconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        ...styles.chipIconBtn,
        ...(disabled ? styles.chipIconBtnDisabled : hover ? styles.chipIconBtnHover : {}),
      }}
    >
      {children}
    </button>
  );
}

export interface ClassificationEditSubmit {
  intents?: SupportIntent[];
  resetIntents?: boolean;
  orderChange?:
    | { type: "candidate"; orderId: string; candidate: OrderFacts }
    | { type: "search"; orderNumber: string }
    | { type: "detach" }
    | { type: "reset" };
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(15, 23, 42, 0.55)",
    backdropFilter: "blur(2px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: "16px",
  },
  panel: {
    background: "#fff",
    borderRadius: "16px",
    width: "min(580px, 100%)",
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 20px 50px rgba(15,23,42,0.25)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 22px",
    borderBottom: "1px solid var(--ui-slate-200)",
  },
  title: { margin: 0, fontSize: "16px", fontWeight: 600, color: "var(--ui-slate-900)" },
  closeBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: "20px",
    color: "var(--ui-slate-500)",
    lineHeight: 1,
    padding: "4px 8px",
    borderRadius: "6px",
  },
  body: { padding: "20px 22px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "22px" },
  sectionTitle: {
    margin: 0,
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: "var(--ui-slate-500)",
  },
  chipRow: { display: "flex", flexWrap: "wrap", gap: "8px" },
  chipBase: {
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
    padding: "4px 4px 4px 12px",
    borderRadius: "999px",
    fontSize: "13px",
    fontWeight: 500,
    border: "1px solid",
    overflow: "hidden",
  },
  chipPrimary: { background: "#dcfce7", borderColor: "#86efac", color: "#14532d" },
  chipSecondary: { background: "var(--ui-slate-100)", borderColor: "var(--ui-slate-200)", color: "var(--ui-slate-700)" },
  chipIconBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    width: "22px",
    height: "22px",
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "13px",
    color: "inherit",
    opacity: 0.65,
    padding: 0,
    transition: "opacity 0.12s, background 0.12s",
  },
  chipIconBtnHover: { opacity: 1, background: "rgba(15,23,42,0.10)" },
  chipIconBtnDisabled: { opacity: 0.25, cursor: "not-allowed" },
  primaryBadge: {
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    background: "#15803d",
    color: "#fff",
    padding: "1px 6px",
    borderRadius: "999px",
    marginRight: "4px",
  },
  select: {
    width: "100%",
    padding: "8px 10px",
    fontSize: "13px",
    border: "1px solid var(--ui-slate-300)",
    borderRadius: "8px",
    background: "#fff",
    color: "var(--ui-slate-800)",
  },
  resetLink: {
    background: "transparent",
    border: "none",
    color: "var(--ui-blue-600)",
    cursor: "pointer",
    fontSize: "12px",
    padding: 0,
    textDecoration: "underline",
    alignSelf: "flex-start",
  },
  radioList: { display: "flex", flexDirection: "column", gap: "6px" },
  radioRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 12px",
    border: "1px solid var(--ui-slate-200)",
    borderRadius: "10px",
    cursor: "pointer",
    transition: "border-color 0.12s, background 0.12s",
  },
  radioRowSelected: {
    borderColor: "var(--ui-blue-500)",
    background: "var(--ui-blue-50)",
  },
  radioInput: { accentColor: "var(--ui-blue-600)", margin: 0, cursor: "pointer" },
  radioLabel: { fontSize: "13px", color: "var(--ui-slate-800)", lineHeight: 1.4, flex: 1, minWidth: 0 },
  radioMuted: { fontSize: "12px", color: "var(--ui-slate-500)" },
  searchRow: {
    display: "flex",
    gap: "8px",
    marginTop: "6px",
    paddingLeft: "32px",
  },
  searchInput: {
    flex: 1,
    padding: "8px 12px",
    fontSize: "13px",
    border: "1px solid var(--ui-slate-300)",
    borderRadius: "8px",
    outline: "none",
    color: "var(--ui-slate-800)",
  },
  errorBanner: {
    marginTop: "4px",
    padding: "8px 12px",
    borderRadius: "8px",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    color: "#b91c1c",
    fontSize: "13px",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "14px 22px",
    borderTop: "1px solid var(--ui-slate-200)",
    background: "var(--ui-slate-50)",
  },
  btnSecondary: {
    padding: "8px 14px",
    fontSize: "13px",
    fontWeight: 500,
    border: "1px solid var(--ui-slate-300)",
    borderRadius: "8px",
    background: "#fff",
    color: "var(--ui-slate-800)",
    cursor: "pointer",
  },
  btnPrimary: {
    padding: "8px 16px",
    fontSize: "13px",
    fontWeight: 600,
    border: "1px solid var(--ui-blue-700)",
    borderRadius: "8px",
    background: "var(--ui-blue-600)",
    color: "#fff",
    cursor: "pointer",
  },
  btnDisabled: { opacity: 0.5, cursor: "not-allowed" },
};

export function ClassificationEditModal({
  analysis,
  onSubmit,
  onClose,
  isSubmitting,
  errorCode,
}: {
  analysis: SupportAnalysis;
  onSubmit: (edit: ClassificationEditSubmit) => void;
  onClose: () => void;
  isSubmitting: boolean;
  errorCode?: string;
}) {
  const { t } = useTranslation();
  const [intents, setIntents] = useState<SupportIntent[]>(
    analysis.intents && analysis.intents.length > 0 ? [...analysis.intents] : [analysis.intent],
  );
  const [resetIntents, setResetIntents] = useState(false);

  const initialOrderId = analysis.order?.id ?? null;
  const [orderMode, setOrderMode] = useState<"candidate" | "search" | "detach" | "reset">(
    initialOrderId ? "candidate" : "detach",
  );
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(initialOrderId);
  const [searchInput, setSearchInput] = useState("");

  const moveIntent = (idx: number, delta: -1 | 1) => {
    const next = [...intents];
    const target = idx + delta;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setIntents(next);
    setResetIntents(false);
  };

  const removeIntent = (idx: number) => {
    setIntents(intents.filter((_, i) => i !== idx));
    setResetIntents(false);
  };

  const addIntent = (value: SupportIntent) => {
    if (intents.includes(value)) return;
    setIntents([...intents, value]);
    setResetIntents(false);
  };

  const available = SUPPORT_INTENTS.filter((v) => !intents.includes(v));
  const intentLabel = (value: SupportIntent) =>
    t(`analysis.intent_${value}`, { defaultValue: value.replace(/_/g, " ") });

  const handleSubmit = () => {
    const payload: ClassificationEditSubmit = {};
    if (resetIntents) {
      payload.resetIntents = true;
    } else if (
      JSON.stringify(intents) !== JSON.stringify(analysis.intents ?? [analysis.intent])
    ) {
      payload.intents = intents;
    }

    if (orderMode === "candidate") {
      if (selectedCandidateId && selectedCandidateId !== initialOrderId) {
        const cand =
          analysis.orderCandidates.find((o) => o.id === selectedCandidateId) ??
          (analysis.order?.id === selectedCandidateId ? analysis.order : null);
        if (cand) {
          payload.orderChange = { type: "candidate", orderId: cand.id, candidate: cand };
        }
      }
    } else if (orderMode === "search" && searchInput.trim().length > 0) {
      payload.orderChange = { type: "search", orderNumber: searchInput.trim() };
    } else if (orderMode === "detach" && initialOrderId) {
      payload.orderChange = { type: "detach" };
    } else if (orderMode === "reset") {
      payload.orderChange = { type: "reset" };
    }

    onSubmit(payload);
  };

  const canSubmit = !resetIntents ? intents.length > 0 : true;
  const candidateRows: { order: OrderFacts; isCurrent: boolean }[] = [
    ...(analysis.order ? [{ order: analysis.order, isCurrent: true }] : []),
    ...analysis.orderCandidates
      .filter((c) => c.id !== analysis.order?.id)
      .map((order) => ({ order, isCurrent: false })),
  ];

  return (
    <div role="dialog" aria-modal="true" style={styles.backdrop} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={styles.panel}>
        <div style={styles.header}>
          <h2 style={styles.title}>
            {t("classification.editTitle", "Modifier la classification")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.cancel", "Fermer")}
            style={styles.closeBtn}
          >
            ×
          </button>
        </div>

        <div style={styles.body}>
          {/* Intents editor */}
          <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <h3 style={styles.sectionTitle}>{t("classification.intents", "Intentions")}</h3>

            <div style={styles.chipRow}>
              {intents.length === 0 && (
                <span style={{ fontSize: "13px", color: "var(--ui-slate-500)", fontStyle: "italic" }}>
                  {t("classification.noIntent", "Aucune intention sélectionnée")}
                </span>
              )}
              {intents.map((value, idx) => {
                const isPrimary = idx === 0;
                return (
                  <span
                    key={value}
                    style={{ ...styles.chipBase, ...(isPrimary ? styles.chipPrimary : styles.chipSecondary) }}
                  >
                    {isPrimary && (
                      <span style={styles.primaryBadge}>
                        {t("classification.primary", "Principal")}
                      </span>
                    )}
                    <span>{intentLabel(value)}</span>
                    <ChipIconBtn
                      label={
                        idx === 0
                          ? t("classification.alreadyPrimary", "Déjà l'intention principale")
                          : isPrimary
                            ? t("classification.demoteIntent", "Rétrograder")
                            : t("classification.moveIntentUp", "Monter (rendre principal si en tête)")
                      }
                      onClick={() => moveIntent(idx, -1)}
                      disabled={idx === 0}
                    >
                      ↑
                    </ChipIconBtn>
                    <ChipIconBtn
                      label={
                        idx === intents.length - 1
                          ? t("classification.alreadyLast", "Déjà en dernière position")
                          : t("classification.moveIntentDown", "Descendre")
                      }
                      onClick={() => moveIntent(idx, 1)}
                      disabled={idx === intents.length - 1}
                    >
                      ↓
                    </ChipIconBtn>
                    <ChipIconBtn
                      label={t("classification.removeIntent", "Retirer cette intention")}
                      onClick={() => removeIntent(idx)}
                    >
                      ×
                    </ChipIconBtn>
                  </span>
                );
              })}
            </div>

            {available.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) addIntent(e.target.value as SupportIntent);
                }}
                style={styles.select}
              >
                <option value="">+ {t("classification.addIntent", "Ajouter une intention")}</option>
                {available.map((v) => (
                  <option key={v} value={v}>{intentLabel(v)}</option>
                ))}
              </select>
            )}

            {analysis.manualOverrides?.intents && (
              <button
                type="button"
                onClick={() => {
                  setResetIntents(true);
                  setIntents([]);
                }}
                style={styles.resetLink}
              >
                {t("classification.resetIntents", "Réinitialiser les intentions")}
              </button>
            )}
          </section>

          {/* Order editor */}
          <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <h3 style={styles.sectionTitle}>{t("classification.linkedOrder", "Commande liée")}</h3>

            <div style={styles.radioList}>
              {candidateRows.map(({ order, isCurrent }) => {
                const selected = orderMode === "candidate" && selectedCandidateId === order.id;
                return (
                  <label
                    key={order.id}
                    style={{ ...styles.radioRow, ...(selected ? styles.radioRowSelected : {}) }}
                  >
                    <input
                      type="radio"
                      name="orderChoice"
                      checked={selected}
                      onChange={() => {
                        setOrderMode("candidate");
                        setSelectedCandidateId(order.id);
                      }}
                      style={styles.radioInput}
                    />
                    <span style={styles.radioLabel}>
                      <strong>{order.name}</strong>
                      {isCurrent && (
                        <span
                          style={{
                            marginLeft: "8px",
                            fontSize: "10px",
                            background: "var(--ui-slate-200)",
                            color: "var(--ui-slate-700)",
                            padding: "1px 6px",
                            borderRadius: "999px",
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          {t("classification.currentOrder", "actuelle")}
                        </span>
                      )}
                      <div style={styles.radioMuted}>
                        {order.customerName ?? "—"} · {new Date(order.createdAt).toLocaleDateString()}
                      </div>
                    </span>
                  </label>
                );
              })}

              <label
                style={{ ...styles.radioRow, ...(orderMode === "search" ? styles.radioRowSelected : {}) }}
              >
                <input
                  type="radio"
                  name="orderChoice"
                  checked={orderMode === "search"}
                  onChange={() => setOrderMode("search")}
                  style={styles.radioInput}
                />
                <span style={styles.radioLabel}>
                  {t("classification.otherOrderNumber", "Autre numéro de commande")}
                </span>
              </label>
              {orderMode === "search" && (
                <div style={styles.searchRow}>
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="#1234"
                    style={styles.searchInput}
                    autoFocus
                  />
                </div>
              )}

              <label
                style={{ ...styles.radioRow, ...(orderMode === "detach" ? styles.radioRowSelected : {}) }}
              >
                <input
                  type="radio"
                  name="orderChoice"
                  checked={orderMode === "detach"}
                  onChange={() => setOrderMode("detach")}
                  style={styles.radioInput}
                />
                <span style={styles.radioLabel}>
                  {t("classification.detach", "Aucune commande (détacher)")}
                </span>
              </label>

              {analysis.manualOverrides?.order && (
                <label
                  style={{ ...styles.radioRow, ...(orderMode === "reset" ? styles.radioRowSelected : {}) }}
                >
                  <input
                    type="radio"
                    name="orderChoice"
                    checked={orderMode === "reset"}
                    onChange={() => setOrderMode("reset")}
                    style={styles.radioInput}
                  />
                  <span style={styles.radioLabel}>
                    {t("classification.resetOrder", "Réinitialiser (laisser l'app rechercher)")}
                  </span>
                </label>
              )}
            </div>
          </section>

          {errorCode && (
            <div style={styles.errorBanner}>
              {t(`classification.errors.${errorCode}`, errorCode)}
            </div>
          )}
        </div>

        <div style={styles.footer}>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            style={{ ...styles.btnSecondary, ...(isSubmitting ? styles.btnDisabled : {}) }}
          >
            {t("common.cancel", "Annuler")}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || isSubmitting}
            style={{ ...styles.btnPrimary, ...(!canSubmit || isSubmitting ? styles.btnDisabled : {}) }}
          >
            {isSubmitting
              ? t("common.saving", "Enregistrement…")
              : t("common.save", "Enregistrer")}
          </button>
        </div>
      </div>
    </div>
  );
}
