import type {
  OrderFacts,
  SupportAnalysis,
  SupportIntent,
  TrackingFacts,
  Warning,
} from "./types";

interface DraftInput {
  intent: SupportIntent;
  order: OrderFacts | null;
  tracking: TrackingFacts | null;
  warnings: Warning[];
}

function greeting(order: OrderFacts | null): string {
  const first = order?.customerName?.split(" ")[0];
  return first ? `Hi ${first},` : "Hello,";
}

function signoff(): string {
  return "Best regards,\nCustomer Support";
}

function trackingBlock(tracking: TrackingFacts | null): string {
  if (!tracking || tracking.source === "none") return "";
  const lines: string[] = [];
  if (tracking.carrier) lines.push(`Carrier: ${tracking.carrier}`);
  if (tracking.trackingNumber)
    lines.push(`Tracking number: ${tracking.trackingNumber}`);
  if (tracking.trackingUrl) lines.push(`Tracking link: ${tracking.trackingUrl}`);
  if (tracking.inferred) {
    lines.push(
      "(Note: carrier/link inferred from the tracking number — please verify.)",
    );
  }
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

function orderSummary(order: OrderFacts | null): string {
  if (!order) return "";
  const parts: string[] = [`Order ${order.name}`];
  if (order.displayFulfillmentStatus)
    parts.push(`fulfillment: ${order.displayFulfillmentStatus}`);
  if (order.displayFinancialStatus)
    parts.push(`payment: ${order.displayFinancialStatus}`);
  return parts.join(" — ");
}

export function generateDraft(input: DraftInput): string {
  const { intent, order, tracking, warnings } = input;
  const hi = greeting(order);
  const summary = orderSummary(order);
  const track = trackingBlock(tracking);

  // Fallback when we cannot find the order — we must not invent anything.
  if (!order) {
    return [
      hi,
      "",
      "Thank you for reaching out. I was not able to locate your order from the information in your message.",
      "Could you please share your order number (for example #1234) or the email address used at checkout?",
      "",
      signoff(),
    ].join("\n");
  }

  switch (intent) {
    case "where_is_my_order": {
      const body = tracking && tracking.source !== "none"
        ? "Thanks for reaching out. Here is the latest information we have on your order:"
        : "Thanks for reaching out. Your order is in our system, but we do not yet have tracking information to share:";
      return [
        hi,
        "",
        body,
        summary,
        track,
        "Please let me know if anything looks off or if you have further questions.",
        "",
        signoff(),
      ].join("\n");
    }

    case "delivery_delay": {
      return [
        hi,
        "",
        "I'm sorry for the wait. I checked your order and here is what I can confirm:",
        summary,
        track,
        "If the situation does not move in the coming days, please reply to this email and we will investigate further with the carrier.",
        "",
        signoff(),
      ].join("\n");
    }

    case "marked_delivered_not_received": {
      return [
        hi,
        "",
        "I'm sorry to hear the parcel has not reached you even though it shows as delivered. Here is what I have on file:",
        summary,
        track,
        "Could you please check with neighbours and any safe-drop location, and confirm the delivery address on the order is correct? We will open an investigation with the carrier in parallel.",
        "",
        signoff(),
      ].join("\n");
    }

    case "package_stuck": {
      return [
        hi,
        "",
        "Thanks for letting us know. I've reviewed the tracking information for your order:",
        summary,
        track,
        "We will contact the carrier to ask for an update. I'll get back to you as soon as I have more information.",
        "",
        signoff(),
      ].join("\n");
    }

    case "refund_request": {
      return [
        hi,
        "",
        "Thank you for your message. I have located your order:",
        summary,
        "",
        "Before processing anything, could you share a few more details about the reason for the refund request? Once I have that, I'll review the order with our team and come back to you with next steps.",
        "",
        signoff(),
      ].join("\n");
    }

    case "unknown":
    default: {
      const hasWarnings = warnings.length > 0;
      return [
        hi,
        "",
        "Thanks for reaching out. I've located the following order on our side:",
        summary,
        track,
        hasWarnings
          ? "Could you please clarify what you need help with so I can assist you better?"
          : "Could you tell me a bit more about what you'd like help with?",
        "",
        signoff(),
      ].join("\n");
    }
  }
}

/** Convenience builder to assemble a full SupportAnalysis.draftReply. */
export function buildDraft(a: Omit<SupportAnalysis, "draftReply">): string {
  return generateDraft({
    intent: a.intent,
    order: a.order,
    tracking: a.tracking,
    warnings: a.warnings,
  });
}
