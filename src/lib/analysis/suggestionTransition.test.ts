import { describe, it, expect } from "vitest";
import {
  decideSuggestionTransition,
  validateSuggestionLabel,
  LABEL_MAX_LENGTH,
} from "@/lib/analysis/suggestionTransition";

describe("decideSuggestionTransition", () => {
  it("PENDING -> approve => apply", () => {
    expect(decideSuggestionTransition({ currentStatus: "PENDING", action: "approve", hasLabelEdit: false }))
      .toEqual({ kind: "apply" });
  });

  it("PENDING -> approve with label edit => apply", () => {
    expect(decideSuggestionTransition({ currentStatus: "PENDING", action: "approve", hasLabelEdit: true }))
      .toEqual({ kind: "apply" });
  });

  it("PENDING -> reject => apply", () => {
    expect(decideSuggestionTransition({ currentStatus: "PENDING", action: "reject", hasLabelEdit: false }))
      .toEqual({ kind: "apply" });
  });

  it("APPROVED -> approve (no edit) => idempotent", () => {
    expect(decideSuggestionTransition({ currentStatus: "APPROVED", action: "approve", hasLabelEdit: false }))
      .toEqual({ kind: "idempotent" });
  });

  it("APPROVED -> approve WITH label edit => conflict (edit only allowed while PENDING)", () => {
    const r = decideSuggestionTransition({ currentStatus: "APPROVED", action: "approve", hasLabelEdit: true });
    expect(r.kind).toBe("conflict");
  });

  it("APPROVED -> reject => conflict (409)", () => {
    const r = decideSuggestionTransition({ currentStatus: "APPROVED", action: "reject", hasLabelEdit: false });
    expect(r.kind).toBe("conflict");
  });

  it("REJECTED -> approve => apply (reversible)", () => {
    expect(decideSuggestionTransition({ currentStatus: "REJECTED", action: "approve", hasLabelEdit: false }))
      .toEqual({ kind: "apply" });
  });

  it("REJECTED -> reject => idempotent", () => {
    expect(decideSuggestionTransition({ currentStatus: "REJECTED", action: "reject", hasLabelEdit: false }))
      .toEqual({ kind: "idempotent" });
  });
});

describe("validateSuggestionLabel", () => {
  it("undefined/null => ok, no edit requested (empty label sentinel)", () => {
    expect(validateSuggestionLabel(undefined)).toEqual({ ok: true, label: "" });
    expect(validateSuggestionLabel(null)).toEqual({ ok: true, label: "" });
  });

  it("trims whitespace", () => {
    expect(validateSuggestionLabel("  landscape  ")).toEqual({ ok: true, label: "landscape" });
  });

  it("rejects empty/blank string as invalid edit", () => {
    expect(validateSuggestionLabel("").ok).toBe(false);
    expect(validateSuggestionLabel("   ").ok).toBe(false);
  });

  it(`rejects labels longer than ${LABEL_MAX_LENGTH} chars`, () => {
    const tooLong = "a".repeat(LABEL_MAX_LENGTH + 1);
    const r = validateSuggestionLabel(tooLong);
    expect(r.ok).toBe(false);
  });

  it(`accepts exactly ${LABEL_MAX_LENGTH} chars`, () => {
    const exact = "a".repeat(LABEL_MAX_LENGTH);
    expect(validateSuggestionLabel(exact)).toEqual({ ok: true, label: exact });
  });
});
