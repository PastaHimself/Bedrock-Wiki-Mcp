import { describe, expect, it, vi } from "vitest";
import { initializeOptionalSemantic } from "../../src/semantic/optional.js";

describe("optional semantic startup", () => {
  it("does not initialize when semantic retrieval is disabled", async () => {
    const initialize = vi.fn(async () => ({ ready: true }));
    const warn = vi.fn();
    await expect(initializeOptionalSemantic(false, initialize, warn)).resolves.toBeUndefined();
    expect(initialize).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to lexical availability when semantic initialization fails", async () => {
    const warn = vi.fn();
    await expect(initializeOptionalSemantic(true, async () => {
      throw new Error("model cache missing\nwith noisy detail");
    }, warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("continuing with lexical search only");
    expect(warn.mock.calls[0]?.[0]).not.toContain("\n");
  });

  it("returns a ready semantic retriever when initialization succeeds", async () => {
    const retriever = { ready: true };
    await expect(initializeOptionalSemantic(true, async () => retriever, vi.fn())).resolves.toBe(retriever);
  });
});
