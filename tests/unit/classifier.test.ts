import { describe, expect, it } from "vitest";
import { classifyPath } from "../../src/ingestion/classifier.js";

describe("path classifier", () => {
  it("recognizes core Bedrock content categories", () => {
    expect(classifyPath("creator/ScriptAPI/minecraft/server/World.md").category).toBe("script_api");
    expect(classifyPath("behavior_pack/entities/zombie.json").category).toBe("entities");
    expect(classifyPath("resource_pack/animation_controllers/a.json").category).toBe("animation_controllers");
    expect(classifyPath("behavior_pack/manifest.json").category).toBe("manifests");
  });
});
