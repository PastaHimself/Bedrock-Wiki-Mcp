import { describe, expect, it } from "vitest";
import { parseScriptApi } from "../../src/parsers/script-api.js";

describe("Script API parser", () => {
  it("keeps member signatures and metadata together", () => {
    const parsed = parseScriptApi(`---\ntitle: minecraft/server.WorldAfterEvents Class\n---\n# WorldAfterEvents Class\nOverview.\n\n## Properties\n\n### **playerSpawn**\n\`read-only playerSpawn: PlayerSpawnAfterEventSignal;\`\nFires after a player spawns.`, "creator/ScriptAPI/minecraft/server/WorldAfterEvents.md");
    const member = parsed.chunks.find((chunk) => chunk.identifier === "WorldAfterEvents.playerSpawn");
    expect(parsed.apiPackage).toBe("@minecraft/server");
    expect(member?.content).toContain("PlayerSpawnAfterEventSignal");
    expect(member?.symbolKind).toBe("property");
  });

  it("marks experimental member monikers without making the whole file historical", () => {
    const parsed = parseScriptApi(`# WorldAfterEvents Class\n## Properties\n::: moniker range="=minecraft-bedrock-experimental"\n### **chatSend**\nPre-release member.\n::: moniker-end`, "creator/ScriptAPI/minecraft/server/WorldAfterEvents.md");
    const member = parsed.chunks.find((chunk) => chunk.identifier === "WorldAfterEvents.chatSend");
    expect(member?.stability).toBe("experimental");
    expect(member?.lifecycle).toBe("active");
  });

  it("marks prior API documents as historical", () => {
    const parsed = parseScriptApi("# World Class\nOld docs.", "creator/PriorScriptAPI/minecraft/server-1xx/World.md");
    expect(parsed.apiPackage).toBe("@minecraft/server");
    expect(parsed.chunks[0]?.lifecycle).toBe("historical");
  });
});
