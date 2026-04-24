import { describe, it, expect } from "vitest";
import { buildReplySubject } from "../draft-subject";

describe("buildReplySubject", () => {
  it("prepends Re: to a plain subject", () => {
    expect(buildReplySubject("Where is my order?")).toBe("Re: Where is my order?");
  });

  it("does not double-prefix when subject already starts with Re:", () => {
    expect(buildReplySubject("Re: Where is my order?")).toBe("Re: Where is my order?");
  });

  it("handles case-insensitive Re: prefix", () => {
    expect(buildReplySubject("RE: Urgent question")).toBe("Re: Urgent question");
    expect(buildReplySubject("re: test")).toBe("Re: test");
  });

  it("returns Re: for an empty subject", () => {
    expect(buildReplySubject("")).toBe("Re: ");
  });

  it("strips multiple nested Re: prefixes", () => {
    expect(buildReplySubject("Re: Re: Re: Order question")).toBe("Re: Order question");
  });
});
