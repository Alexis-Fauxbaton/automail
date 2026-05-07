import { describe, it, expect } from "vitest";
import { markdownToHtml } from "../markdown-to-html";

describe("markdownToHtml", () => {
  it("converts bold", () => {
    expect(markdownToHtml("Hello **world**")).toContain("<strong>world</strong>");
  });

  it("converts italic", () => {
    expect(markdownToHtml("Hello *world*")).toContain("<em>world</em>");
  });

  it("converts unordered list", () => {
    const html = markdownToHtml("- item one\n- item two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item one</li>");
  });

  it("converts ordered list", () => {
    const html = markdownToHtml("1. first\n2. second");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
  });

  it("converts blockquote", () => {
    expect(markdownToHtml("> quoted text")).toContain("<blockquote>");
  });

  it("converts link", () => {
    const html = markdownToHtml("[click here](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("click here");
  });

  it("returns plain paragraphs for plain text", () => {
    const html = markdownToHtml("Hello world");
    expect(html).toContain("Hello world");
    expect(html).not.toContain("<script");
  });

  it("strips script tags for safety", () => {
    const html = markdownToHtml('<script>alert("xss")</script>plain text');
    expect(html).not.toContain("<script");
  });
});
