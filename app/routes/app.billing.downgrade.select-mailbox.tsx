import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { redirect, data } from "react-router";
import { useTranslation } from "react-i18next";

import { authenticate } from "../shopify.server";
import {
  computeOverflowForPlanSwitch,
  resolveOverflowImmediate,
} from "../lib/billing/downgrade-overflow";
import type { PlanId } from "../lib/billing/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const targetPlanId = (url.searchParams.get("to") ?? "starter") as PlanId;

  const overflow = await computeOverflowForPlanSwitch({
    shop: session.shop,
    targetPlanId,
  });

  if (!overflow.hasOverflow) {
    throw redirect("/app/billing");
  }

  return { overflow, targetPlanId };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const to = (formData.get("to") ?? "starter") as PlanId;
  const keep = formData.get("keep");

  if (!keep || typeof keep !== "string") {
    throw data({ error: "missing_keep" }, { status: 400 });
  }

  await resolveOverflowImmediate({
    shop: session.shop,
    keepMailConnectionId: keep,
    targetPlanId: to,
  });

  throw redirect(`/app/billing?planId=${to}&downgrade-confirmed=1`);
};

export default function DowngradeSelectMailboxPage() {
  const { overflow, targetPlanId } = useLoaderData<typeof loader>();
  const { t } = useTranslation();

  return (
    <div
      style={{
        padding: "2.5rem 1.5rem 4rem",
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: 600,
        margin: "0 auto",
        color: "#0f172a",
      }}
    >
      <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 8, letterSpacing: -0.3 }}>
        {t("billing.downgrade.title", { targetPlanId })}
      </h1>

      <p style={{ fontSize: 15, color: "#475569", marginBottom: 12 }}>
        {t("billing.downgrade.intro", {
          current: overflow.currentCount,
          limit: overflow.targetLimit,
          targetPlanId,
        })}
      </p>

      <div
        role="alert"
        style={{
          background: "#fef2f2",
          color: "#991b1b",
          border: "1px solid #fecaca",
          borderRadius: 8,
          padding: "12px 16px",
          fontSize: 14,
          marginBottom: 28,
        }}
      >
        {t("billing.downgrade.warning")}
      </div>

      <div
        style={{
          background: "white",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          padding: "24px",
          boxShadow: "0 1px 3px rgba(15,23,42,0.04)",
        }}
      >
        <form method="post">
          <input type="hidden" name="to" value={targetPlanId} />

          <fieldset style={{ border: "none", padding: 0, margin: "0 0 24px" }}>
            <legend
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "#0f172a",
                marginBottom: 12,
                display: "block",
              }}
            >
              {t("billing.downgrade.intro", {
                current: overflow.currentCount,
                limit: overflow.targetLimit,
                targetPlanId,
              })}
            </legend>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {overflow.mailboxes.map((mailbox) => (
                <label
                  key={mailbox.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 16px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 8,
                    cursor: "pointer",
                    fontSize: 14,
                    transition: "border-color 0.15s ease",
                  }}
                >
                  <input
                    type="radio"
                    name="keep"
                    value={mailbox.id}
                    required
                    style={{ accentColor: "#1f2937", width: 16, height: 16, flexShrink: 0 }}
                  />
                  <span style={{ color: "#0f172a", fontWeight: 500 }}>
                    {mailbox.email}
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 12,
                        color: "#64748b",
                        fontWeight: 400,
                        textTransform: "capitalize",
                      }}
                    >
                      ({mailbox.provider})
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", alignItems: "center" }}>
            <a
              href="/app/billing"
              style={{
                fontSize: 14,
                color: "#64748b",
                textDecoration: "underline",
                cursor: "pointer",
              }}
            >
              {t("common.cancel")}
            </a>
            <button
              type="submit"
              style={{
                padding: "10px 20px",
                borderRadius: 8,
                border: "none",
                background: "#dc2626",
                color: "white",
                fontWeight: 600,
                fontSize: 14,
                cursor: "pointer",
                transition: "background 0.15s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#b91c1c";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#dc2626";
              }}
            >
              {t("billing.downgrade.confirm")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
