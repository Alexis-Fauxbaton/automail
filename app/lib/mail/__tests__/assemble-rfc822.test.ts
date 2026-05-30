import { describe, it, expect } from "vitest";
import {
  assembleRfc822,
  buildSubjectWithRePrefix,
  quoteOriginalHtml,
  generateMessageId,
  renderRfc822,
  escapeHtml,
} from "../assemble-rfc822";

describe("buildSubjectWithRePrefix", () => {
  it("adds Re: prefix if missing", () => {
    expect(buildSubjectWithRePrefix("Question commande")).toBe("Re: Question commande");
  });
  it("does not double-prefix Re:", () => {
    expect(buildSubjectWithRePrefix("Re: Question commande")).toBe("Re: Question commande");
  });
  it("handles RE: (uppercase)", () => {
    expect(buildSubjectWithRePrefix("RE: Question")).toBe("RE: Question");
  });
});

describe("escapeHtml", () => {
  it("escapes <, >, &, \", '", () => {
    expect(escapeHtml(`<script>alert("xss")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
    );
  });
  it("escapes lone ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });
});

describe("quoteOriginalHtml", () => {
  it("wraps the body in a styled blockquote with <br> for newlines", () => {
    const out = quoteOriginalHtml("ligne 1\nligne 2");
    expect(out).toContain("<blockquote");
    expect(out).toContain("ligne 1<br>ligne 2");
  });
  it("returns empty string for empty body", () => {
    expect(quoteOriginalHtml("")).toBe("");
  });
  it("normalizes CRLF to LF", () => {
    const out = quoteOriginalHtml("a\r\nb");
    expect(out).toContain("a<br>b");
  });
  it("HTML-escapes the quoted content", () => {
    const out = quoteOriginalHtml(`<script>alert("xss")</script>`);
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });
});

describe("generateMessageId", () => {
  it("returns a Message-ID using the shop as domain", () => {
    const id = generateMessageId("integration-test.myshopify.com");
    expect(id).toMatch(/^[a-z0-9-]+@integration-test\.myshopify\.com$/);
  });
  it("produces distinct ids on consecutive calls", () => {
    const a = generateMessageId("x.myshopify.com");
    const b = generateMessageId("x.myshopify.com");
    expect(a).not.toBe(b);
  });
});

describe("assembleRfc822", () => {
  it("builds an HTML payload from draft + thread + customer", () => {
    const payload = assembleRfc822({
      shop: "integration-test.myshopify.com",
      mailbox: { email: "support@brand.com", fromName: "AMBIENT HOME" },
      customer: { email: "client@gmail.com", name: "Jean Dupont" },
      originalIncoming: {
        rfcMessageId: "orig-msg-1@gmail.com",
        receivedAt: new Date("2026-05-28T10:30:00Z"),
        subject: "Ma commande",
        bodyText: "Bonjour, où est ma commande #1234 ?",
      },
      thread: { references: "orig-prev@gmail.com orig-msg-1@gmail.com" },
      draftBody: "<p>Bonjour Jean, votre commande est en transit. Suivi attendu sous 2 jours.</p>",
    });
    expect(payload.fromEmail).toBe("support@brand.com");
    expect(payload.fromName).toBe("AMBIENT HOME");
    expect(payload.toEmails).toEqual(["client@gmail.com"]);
    expect(payload.subject).toBe("Re: Ma commande");
    expect(payload.inReplyToRfcId).toBe("orig-msg-1@gmail.com");
    expect(payload.references).toBe("orig-prev@gmail.com orig-msg-1@gmail.com");
    expect(payload.rfcMessageId).toMatch(/@integration-test\.myshopify\.com$/);
    // Draft HTML passes through unchanged
    expect(payload.bodyText).toContain("<p>Bonjour Jean, votre commande est en transit.");
    // Quote header (HTML-escaped customer label)
    expect(payload.bodyText).toContain("Le 28/05/2026, Jean Dupont &lt;client@gmail.com&gt; a écrit :");
    // Original body inside an HTML blockquote (escaped)
    expect(payload.bodyText).toContain("<blockquote");
    expect(payload.bodyText).toContain("Bonjour, où est ma commande #1234 ?");
  });

  it("falls back to customer email if no name", () => {
    const payload = assembleRfc822({
      shop: "x.myshopify.com",
      mailbox: { email: "s@b.com", fromName: "" },
      customer: { email: "c@g.com", name: "" },
      originalIncoming: {
        rfcMessageId: "m1@g.com",
        receivedAt: new Date("2026-05-28T10:00:00Z"),
        subject: "Q",
        bodyText: "body",
      },
      thread: { references: "" },
      draftBody: "<p>answer</p>",
    });
    expect(payload.bodyText).toContain("Le 28/05/2026, c@g.com a écrit :");
  });

  it("preserves the references chain as provided", () => {
    const payload = assembleRfc822({
      shop: "x.myshopify.com",
      mailbox: { email: "s@b.com" },
      customer: { email: "c@g.com" },
      originalIncoming: {
        rfcMessageId: "m1@g.com",
        receivedAt: new Date(),
        subject: "Q",
        bodyText: "body",
      },
      thread: { references: "prev@g.com m1@g.com" },
      draftBody: "answer",
    });
    expect(payload.references).toBe("prev@g.com m1@g.com");
  });

  it("threads inReplyToExternalMessageId through to the payload", () => {
    const payload = assembleRfc822({
      shop: "x.myshopify.com",
      mailbox: { email: "s@b.com" },
      customer: { email: "c@g.com" },
      originalIncoming: {
        rfcMessageId: "m1@g.com",
        externalMessageId: "AAMkAGUyNTEzNzMy",
        receivedAt: new Date(),
        subject: "Q",
        bodyText: "body",
      },
      thread: { references: "" },
      draftBody: "answer",
    });
    expect(payload.inReplyToExternalMessageId).toBe("AAMkAGUyNTEzNzMy");
  });
});

describe("renderRfc822", () => {
  it("produces a valid RFC822 string with all expected headers and text/html content type", () => {
    const rendered = renderRfc822({
      rfcMessageId: "test-id@x.com",
      inReplyToRfcId: "orig@g.com",
      references: "a@g.com b@g.com",
      fromEmail: "s@b.com",
      fromName: "Brand",
      toEmails: ["c@g.com"],
      subject: "Re: hi",
      bodyText: "<p>hello</p>",
    });
    expect(rendered).toContain('From: "Brand" <s@b.com>');
    expect(rendered).toContain("To: c@g.com");
    expect(rendered).toContain("Subject: Re: hi");
    expect(rendered).toContain("Message-ID: <test-id@x.com>");
    expect(rendered).toContain("In-Reply-To: <orig@g.com>");
    expect(rendered).toContain("References: a@g.com b@g.com");
    expect(rendered).toContain("Content-Type: text/html; charset=utf-8");
    expect(rendered.endsWith("<p>hello</p>")).toBe(true);
    // Headers separated by CRLF, blank line before body
    expect(rendered).toMatch(/\r\n\r\n<p>hello<\/p>$/);
  });

  it("omits Cc and From-name when not provided", () => {
    const rendered = renderRfc822({
      rfcMessageId: "id@x.com",
      inReplyToRfcId: "",
      references: "",
      fromEmail: "s@b.com",
      toEmails: ["c@g.com"],
      subject: "Hi",
      bodyText: "body",
    });
    expect(rendered).toContain("From: <s@b.com>");
    expect(rendered).not.toContain("Cc:");
    expect(rendered).not.toContain("In-Reply-To:");
    expect(rendered).not.toContain("References:");
  });
});
