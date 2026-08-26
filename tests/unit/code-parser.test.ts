import { describe, expect, it } from "vitest";
import { parseCode } from "../../src/parsers/code.js";

describe("code parser", () => {
  it("keeps imports with event handler chunks", () => {
    const chunks = parseCode(`import { world } from "@minecraft/server";\n\nworld.afterEvents.playerSpawn.subscribe((event) => {\n  event.player.sendMessage("hello");\n});`, "scripts/main.ts");
    const handler = chunks.find((chunk) => chunk.symbolKind === "event-handler");
    expect(handler?.content).toContain("import { world }");
    expect(handler?.content).toContain("playerSpawn.subscribe");
  });

  it("chunks named functions independently", () => {
    const chunks = parseCode(`function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}`, "scripts/main.js");
    expect(chunks.map((chunk) => chunk.identifier)).toEqual(["one", "two"]);
  });
});
