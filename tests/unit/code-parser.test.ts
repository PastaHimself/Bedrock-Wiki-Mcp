import { describe, expect, it } from "vitest";
import { parseCode } from "../../src/parsers/code.js";

describe("code parser", () => {
  it("keeps imports with event handler chunks and indexes imported Script API symbols", () => {
    const chunks = parseCode(`import { world, Player } from "@minecraft/server";\n\nworld.afterEvents.playerSpawn.subscribe((event) => {\n  event.player.sendMessage("hello");\n});`, "scripts/main.ts");
    const handler = chunks.find((chunk) => chunk.symbolKind === "event-handler");
    expect(handler?.content).toContain("import { world, Player }");
    expect(handler?.content).toContain("playerSpawn.subscribe");
    expect(handler?.identifiers).toContain("@minecraft/server.world");
    expect(handler?.identifiers).toContain("@minecraft/server.Player");
    expect(handler?.identifiers).toContain("world.afterEvents.playerSpawn");
  });

  it("chunks named functions independently", () => {
    const chunks = parseCode(`function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}`, "scripts/main.js");
    expect(chunks.map((chunk) => chunk.identifier)).toEqual(["one", "two"]);
  });

  it("recognizes interfaces enums type aliases and arrow functions", () => {
    const chunks = parseCode(`export interface Options { enabled: boolean; }\n\nexport enum Mode { One, Two }\n\nexport type Name = string;\n\nexport const start = () => { return Mode.One; };`, "scripts/types.ts");
    expect(chunks.map((chunk) => chunk.identifier)).toEqual(["Options", "Mode", "Name", "start"]);
    expect(chunks.find((chunk) => chunk.identifier === "Options")?.symbolKind).toBe("interface");
    expect(chunks.find((chunk) => chunk.identifier === "Mode")?.symbolKind).toBe("enum");
    expect(chunks.find((chunk) => chunk.identifier === "start")?.symbolKind).toBe("function");
  });
});
