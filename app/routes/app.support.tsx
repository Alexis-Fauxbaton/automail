import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useNavigation } from "react-router";

import { authenticate } from "../shopify.server";
import { analyzeSupportEmail } from "../lib/support/orchestrator";
import type { SupportAnalysis } from "../lib/support/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const subject = String(formData.get("subject") ?? "");
  const body = String(formData.get("body") ?? "");

  if (!subject.trim() && !body.trim()) {
    return {
      error: "Please provide the email subject or body.",
      analysis: null as SupportAnalysis | null,
    };
  }

  const analysis = await analyzeSupportEmail({ subject, body, admin });
  return { error: null as string | null, analysis };
};

function Badge({ confidence }: { confidence: SupportAnalysis["confidence"] }) {
  const tone =
    confidence === "high" ? "success" : confidence === "medium" ? "info" : "warning";
  return <s-badge tone={tone}>{confidence.toUpperCase()}</s-badge>;
}

function IdentifiersList({
  identifiers,
}: {
  identifiers: SupportAnalysis["identifiers"];
}) {
  const rows = [
    ["Order number", identifiers.orderNumber && `#${identifiers.orderNumber}`],
    ["Email", identifiers.email],
    ["Customer name", identifiers.customerName],
    ["Tracking number", identifiers.trackingNumber],
  ].filter(([, v]) => !!v) as Array<[string, string]>;

  if (rows.length === 0) {
    return <s-paragraph>No identifiers were extracted from the message.</s-paragraph>;
  }
  return (
    <s-unordered-list>
      {rows.map(([k, v]) => (
        <s-list-item key={k}>
          <s-text>
            <strong>{k}:</strong> {v}
          </s-text>
        </s-list-item>
      ))}
    </s-unordered-list>
  );
}

function OrderBlock({ order }: { order: SupportAnalysis["order"] }) {
  if (!order) {
    return <s-paragraph>No matching Shopify order found.</s-paragraph>;
  }
  return (
    <s-stack direction="block" gap="small-300">
      <s-paragraph>
        <strong>{order.name}</strong> · created {new Date(order.createdAt).toLocaleString()}
      </s-paragraph>
      <s-paragraph>
        Customer: {order.customerName ?? "—"} ({order.customerEmail ?? "no email"})
      </s-paragraph>
      <s-paragraph>
        Fulfillment: {order.displayFulfillmentStatus ?? "—"} · Payment:{" "}
        {order.displayFinancialStatus ?? "—"}
      </s-paragraph>
      {order.lineItems.length > 0 && (
        <s-unordered-list>
          {order.lineItems.map((li, i) => (
            <s-list-item key={i}>
              {li.quantity} × {li.title}
            </s-list-item>
          ))}
        </s-unordered-list>
      )}
    </s-stack>
  );
}

function TrackingBlock({ tracking }: { tracking: SupportAnalysis["tracking"] }) {
  if (!tracking || tracking.source === "none") {
    return <s-paragraph>No tracking data available yet.</s-paragraph>;
  }
  return (
    <s-stack direction="block" gap="small-300">
      {tracking.carrier && (
        <s-paragraph>
          <strong>Carrier:</strong> {tracking.carrier}
          {tracking.inferred ? " (inferred)" : ""}
        </s-paragraph>
      )}
      {tracking.trackingNumber && (
        <s-paragraph>
          <strong>Number:</strong> {tracking.trackingNumber}
        </s-paragraph>
      )}
      {tracking.trackingUrl && (
        <s-paragraph>
          <s-link href={tracking.trackingUrl} target="_blank">
            Open tracking page
          </s-link>
        </s-paragraph>
      )}
      {tracking.status && (
        <s-paragraph>
          <strong>Status:</strong> {tracking.status}
        </s-paragraph>
      )}
      {tracking.agentStatus && (
        <>
          <s-paragraph>
            <strong>Last event:</strong> {tracking.agentStatus.lastEvent}
          </s-paragraph>
          {tracking.agentStatus.lastLocation && (
            <s-paragraph>
              <strong>Last location:</strong> {tracking.agentStatus.lastLocation}
            </s-paragraph>
          )}
          {tracking.agentStatus.estimatedDelivery && (
            <s-paragraph>
              <strong>Estimated delivery:</strong>{" "}
              {tracking.agentStatus.estimatedDelivery}
            </s-paragraph>
          )}
          {tracking.agentStatus.delivered && (
            <s-banner tone="success">Carrier confirms: parcel delivered.</s-banner>
          )}
        </>
      )}
      <s-paragraph>
        <s-text>
          Source: {tracking.source}
          {tracking.agentStatus ? " + live agent check ✓" : ""}
        </s-text>
      </s-paragraph>
    </s-stack>
  );
}

export default function SupportPage() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const analysis = actionData?.analysis ?? null;

  return (
    <s-page heading="Support copilot">
      <s-section heading="Incoming email">
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Subject"
              name="subject"
              placeholder="e.g. Where is my order #1234?"
            />
            <s-text-area
              label="Body"
              name="body"
              rows={10}
              placeholder="Paste the full customer email here…"
            />
            <s-stack direction="inline" gap="base">
              <s-button type="submit" {...(isSubmitting ? { loading: true } : {})}>
                Analyze
              </s-button>
            </s-stack>
            {actionData?.error && (
              <s-banner tone="critical">{actionData.error}</s-banner>
            )}
          </s-stack>
        </Form>
      </s-section>

      {analysis && (
        <>
          <s-section heading="Analysis">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                <strong>Intent:</strong> {analysis.intent} · <strong>Confidence:</strong>{" "}
                <Badge confidence={analysis.confidence} />
              </s-paragraph>

              <s-heading>Extracted identifiers</s-heading>
              <IdentifiersList identifiers={analysis.identifiers} />

              <s-heading>Matched order</s-heading>
              <OrderBlock order={analysis.order} />

              {analysis.orderCandidates.length > 1 && (
                <s-banner tone="warning">
                  {analysis.orderCandidates.length} orders matched — please verify which one
                  is correct before replying.
                </s-banner>
              )}

              <s-heading>Tracking</s-heading>
              <TrackingBlock tracking={analysis.tracking} />

              {analysis.warnings.length > 0 && (
                <>
                  <s-heading>Warnings</s-heading>
                  <s-unordered-list>
                    {analysis.warnings.map((w) => (
                      <s-list-item key={w.code}>{w.message}</s-list-item>
                    ))}
                  </s-unordered-list>
                </>
              )}
            </s-stack>
          </s-section>

          <s-section heading="Draft reply">
            <s-stack direction="block" gap="base">
              <s-text-area
                label="Draft (edit before sending)"
                name="draft"
                rows={14}
                defaultValue={analysis.draftReply}
              />
              <s-paragraph>
                <s-text>
                  This draft is generated from verified data only. Always review before
                  sending.
                </s-text>
              </s-paragraph>
            </s-stack>
          </s-section>
        </>
      )}
    </s-page>
  );
}
