import { describe, it, expect } from "vitest";
import {
  getCurrentAnalysisModelIdSuffix,
  isCurrentAnalysisModelId,
  filterCurrentVersionPendingSuggestions,
} from "@/lib/analysis/currentAnalysisSuggestionFilter";
import { ANALYSIS_PROMPT_VERSION } from "@/lib/analysis/analysisModelId";

describe("getCurrentAnalysisModelIdSuffix", () => {
  it("is ':' + the current ANALYSIS_PROMPT_VERSION", () => {
    expect(getCurrentAnalysisModelIdSuffix()).toBe(`:${ANALYSIS_PROMPT_VERSION}`);
    expect(getCurrentAnalysisModelIdSuffix()).toBe(":ja-tags-v5");
  });
});

describe("isCurrentAnalysisModelId", () => {
  it("true for current-version composite modelIds regardless of provider/model", () => {
    expect(isCurrentAnalysisModelId("openai:gpt-4o-mini:ja-tags-v5")).toBe(true);
    expect(isCurrentAnalysisModelId("mock:mock:ja-tags-v5")).toBe(true);
    // different model, same (current) prompt version → still current
    expect(isCurrentAnalysisModelId("openai:gpt-4o:ja-tags-v5")).toBe(true);
  });

  it("false for older prompt versions", () => {
    expect(isCurrentAnalysisModelId("openai:gpt-4o-mini:ja-tags-v4")).toBe(false);
    expect(isCurrentAnalysisModelId("openai:gpt-4o-mini:ja-tags-v3")).toBe(false);
    expect(isCurrentAnalysisModelId("openai:gpt-4o-mini:ja-tags-v2")).toBe(false);
  });

  it("false for null / undefined", () => {
    expect(isCurrentAnalysisModelId(null)).toBe(false);
    expect(isCurrentAnalysisModelId(undefined)).toBe(false);
  });

  it("false when the suffix merely appears mid-string, not at the end", () => {
    // e.g. a hypothetical "ja-tags-v5x" or version embedded earlier — must NOT match
    expect(isCurrentAnalysisModelId("openai:gpt-4o-mini:ja-tags-v5x")).toBe(false);
    expect(isCurrentAnalysisModelId("openai:ja-tags-v5:gpt-4o-mini")).toBe(false);
  });

  it("false for empty string / unrelated text", () => {
    expect(isCurrentAnalysisModelId("")).toBe(false);
    expect(isCurrentAnalysisModelId("unrelated")).toBe(false);
  });
});

describe("filterCurrentVersionPendingSuggestions", () => {
  it("keeps only current-version suggestions, drops old ones", () => {
    const suggestions = [
      { id: "s1", label: "海", analysis: { modelId: "openai:gpt-4o-mini:ja-tags-v5" } },
      { id: "s2", label: "夕方", analysis: { modelId: "openai:gpt-4o-mini:ja-tags-v2" } },
      { id: "s3", label: "水着", analysis: { modelId: "mock:mock:ja-tags-v5" } },
      { id: "s4", label: "室内", analysis: { modelId: "openai:gpt-4o-mini:ja-tags-v4" } },
    ];
    const result = filterCurrentVersionPendingSuggestions(suggestions);
    expect(result.map((s) => s.id)).toEqual(["s1", "s3"]);
  });

  it("drops a suggestion whose analysis is null or missing", () => {
    const suggestions = [
      { id: "s1", label: "海", analysis: { modelId: "openai:gpt-4o-mini:ja-tags-v5" } },
      { id: "s2", label: "夕方", analysis: null },
      { id: "s3", label: "水着" }, // analysis field entirely absent
    ];
    const result = filterCurrentVersionPendingSuggestions(suggestions);
    expect(result.map((s) => s.id)).toEqual(["s1"]);
  });

  it("does not mutate the input array or its items", () => {
    const suggestions = [
      { id: "s1", label: "海", analysis: { modelId: "openai:gpt-4o-mini:ja-tags-v5" } },
      { id: "s2", label: "夕方", analysis: { modelId: "openai:gpt-4o-mini:ja-tags-v2" } },
    ];
    const copy = JSON.parse(JSON.stringify(suggestions));
    filterCurrentVersionPendingSuggestions(suggestions);
    expect(suggestions).toEqual(copy);
  });

  it("empty input → empty output", () => {
    expect(filterCurrentVersionPendingSuggestions([])).toEqual([]);
  });

  it("is a separate layer from isExcludedGenericLabel (label content is irrelevant here)", () => {
    // Even a label that isExcludedGenericLabel would flag (人物/ポートレート)
    // is NOT filtered by this helper — it only judges by modelId. The two
    // filters are independent and meant to be composed by the caller.
    const suggestions = [
      { id: "s1", label: "人物", analysis: { modelId: "openai:gpt-4o-mini:ja-tags-v5" } },
      { id: "s2", label: "ポートレート", analysis: { modelId: "openai:gpt-4o-mini:ja-tags-v2" } },
    ];
    const result = filterCurrentVersionPendingSuggestions(suggestions);
    // s1 survives THIS filter (current modelId) even though its label would be
    // excluded by isExcludedGenericLabel elsewhere; s2 is dropped for modelId
    // reasons, not label reasons.
    expect(result.map((s) => s.id)).toEqual(["s1"]);
  });
});
