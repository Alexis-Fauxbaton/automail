import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORT_INTENTS, type SupportIntent } from "../lib/support/types";
import type { OrderFacts, SupportAnalysis } from "../lib/support/types";

export interface ClassificationEditSubmit {
  intents?: SupportIntent[];
  resetIntents?: boolean;
  orderChange?:
    | { type: "candidate"; orderId: string; candidate: OrderFacts }
    | { type: "search"; orderNumber: string }
    | { type: "detach" }
    | { type: "reset" };
}

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

  return (
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
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "24px",
          width: "min(560px, 92vw)",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: "18px" }}>
          {t("classification.editTitle", "Modifier la classification")}
        </h2>

        {/* Intents editor */}
        <section style={{ marginTop: "16px" }}>
          <h3 style={{ fontSize: "13px", textTransform: "uppercase", color: "#6d7175" }}>
            {t("classification.intents", "Intentions")}
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
            {intents.map((value, idx) => (
              <span
                key={value}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  padding: "4px 8px",
                  background: idx === 0 ? "#e3f1df" : "#f1f1f1",
                  borderRadius: "999px",
                  fontSize: "12px",
                }}
              >
                <span>{value}</span>
                <button type="button" onClick={() => moveIntent(idx, -1)} disabled={idx === 0} aria-label="Move up">↑</button>
                <button
                  type="button"
                  onClick={() => moveIntent(idx, 1)}
                  disabled={idx === intents.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button type="button" onClick={() => removeIntent(idx)} aria-label="Remove">×</button>
              </span>
            ))}
          </div>
          {available.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) addIntent(e.target.value as SupportIntent);
              }}
              style={{ marginTop: "8px" }}
            >
              <option value="">+ {t("classification.addIntent", "Ajouter une intention")}</option>
              {available.map((v) => (
                <option key={v} value={v}>{v}</option>
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
              style={{ marginTop: "8px", fontSize: "12px" }}
            >
              {t("classification.resetIntents", "Réinitialiser les intentions")}
            </button>
          )}
        </section>

        {/* Order editor */}
        <section style={{ marginTop: "20px" }}>
          <h3 style={{ fontSize: "13px", textTransform: "uppercase", color: "#6d7175" }}>
            {t("classification.linkedOrder", "Commande liée")}
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "8px" }}>
            {analysis.orderCandidates.map((cand) => (
              <label key={cand.id} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <input
                  type="radio"
                  name="orderChoice"
                  checked={orderMode === "candidate" && selectedCandidateId === cand.id}
                  onChange={() => {
                    setOrderMode("candidate");
                    setSelectedCandidateId(cand.id);
                  }}
                />
                <span>{cand.name} — {cand.customerName ?? "—"} — {new Date(cand.createdAt).toLocaleDateString()}</span>
              </label>
            ))}
            <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input
                type="radio"
                name="orderChoice"
                checked={orderMode === "search"}
                onChange={() => setOrderMode("search")}
              />
              <span>{t("classification.otherOrderNumber", "Autre numéro de commande")}</span>
            </label>
            {orderMode === "search" && (
              <div style={{ display: "flex", gap: "6px", paddingLeft: "20px" }}>
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="#1234"
                  style={{ flex: 1 }}
                />
              </div>
            )}
            <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input
                type="radio"
                name="orderChoice"
                checked={orderMode === "detach"}
                onChange={() => setOrderMode("detach")}
              />
              <span>{t("classification.detach", "Aucune commande (détacher)")}</span>
            </label>
            {analysis.manualOverrides?.order && (
              <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <input
                  type="radio"
                  name="orderChoice"
                  checked={orderMode === "reset"}
                  onChange={() => setOrderMode("reset")}
                />
                <span>{t("classification.resetOrder", "Réinitialiser (laisser l'app rechercher)")}</span>
              </label>
            )}
          </div>
        </section>

        {errorCode && (
          <div style={{ marginTop: "12px", color: "#bb2222", fontSize: "13px" }}>
            {t(`classification.errors.${errorCode}`, errorCode)}
          </div>
        )}

        <div style={{ marginTop: "20px", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" onClick={onClose} disabled={isSubmitting}>
            {t("common.cancel", "Annuler")}
          </button>
          <button type="button" onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
            {t("common.save", "Enregistrer")}
          </button>
        </div>
      </div>
    </div>
  );
}
