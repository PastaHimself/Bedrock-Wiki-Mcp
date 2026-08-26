import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { getSchemaVersion, migrateDatabase } from "../../src/db/migrate.js";
import { IndexRepository } from "../../src/db/repository.js";
import { validateIndex } from "../../src/db/validate.js";
import { ingestDocument } from "../../src/ingestion/pipeline.js";
import type { SourceDescriptor } from "../../src/models/source.js";
import { exactIdentifierSearch } from "../../src/search/exact.js";
import { compileFtsQuery, lexicalSearch } from "../../src/search/lexical.js";

const databases: ReturnType<typeof openDatabase>[] = [];

function database() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrateDatabase(db);
  return db;
}

const stableSource: SourceDescriptor = {
  id: "stable",
  name: "Stable official docs",
  tier: 1,
  channel: "stable",
  revision: "abc123",
};

const previewSource: SourceDescriptor = {
  id: "preview",
  name: "Preview docs",
  tier: 1,
  channel: "preview",
  revision: "def456",
};

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("SQLite index", () => {
  it("migrates an empty database idempotently with FTS5 available", () => {
    const db = database();
    expect(getSchemaVersion(db)).toBe(1);
    expect(() => migrateDatabase(db)).not.toThrow();
    const fts = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'").get() as { name: string } | undefined;
    expect(fts?.name).toBe("chunks_fts");
  });

  it("honors the configured SQLite busy timeout", () => {
    const db = openDatabase(":memory:", { timeoutMs: 1234 });
    databases.push(db);
    const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number } | undefined;
    expect(row?.timeout).toBe(1234);
  });

  it("persists documents for exact identifier and lexical retrieval", () => {
    const db = database();
    const repository = new IndexRepository(db);
    const document = ingestDocument({
      source: stableSource,
      path: "behavior_pack/entities/example.json",
      content: JSON.stringify({
        "minecraft:entity": {
          description: { identifier: "example:mob" },
          components: { "minecraft:health": { value: 20, max: 20 } },
        },
      }),
    });

    const documentId = repository.replaceDocument(document);
    expect(documentId).toMatch(/^doc_[a-f0-9]{24}$/);

    const exact = exactIdentifierSearch(db, "minecraft:health");
    expect(exact[0]?.identifier).toBe("minecraft:health");
    expect(exact[0]?.sourceTier).toBe(1);

    const lexical = lexicalSearch(db, "health");
    expect(lexical[0]?.identifier).toBe("minecraft:health");
    expect(lexical[0]?.path).toBe("behavior_pack/entities/example.json");

    const validation = validateIndex(db);
    expect(validation.ok).toBe(true);
    expect(validation.documents).toBe(1);
    expect(validation.chunks).toBe(validation.ftsRows);
    expect(validation.missingFtsRows).toBe(0);
    expect(validation.orphanFtsRows).toBe(0);
  });

  it("replaces a document without leaving stale identifiers or FTS rows", () => {
    const db = database();
    const repository = new IndexRepository(db);
    const path = "behavior_pack/entities/example.json";

    repository.replaceDocument(ingestDocument({
      source: stableSource,
      path,
      content: JSON.stringify({ "minecraft:entity": { description: { identifier: "example:mob" }, components: { "minecraft:health": { value: 20 } } } }),
    }));
    expect(exactIdentifierSearch(db, "minecraft:health")).toHaveLength(1);

    repository.replaceDocument(ingestDocument({
      source: stableSource,
      path,
      content: JSON.stringify({ "minecraft:entity": { description: { identifier: "example:mob" }, components: { "minecraft:movement": { value: 0.2 } } } }),
    }));

    expect(exactIdentifierSearch(db, "minecraft:health")).toHaveLength(0);
    expect(exactIdentifierSearch(db, "minecraft:movement")).toHaveLength(1);
    expect(lexicalSearch(db, "health")).toHaveLength(0);
    expect(validateIndex(db).ok).toBe(true);
  });

  it("removes relational and FTS rows together", () => {
    const db = database();
    const repository = new IndexRepository(db);
    const path = "docs/test.md";
    repository.replaceDocument(ingestDocument({ source: stableSource, path, content: "# Health\nMinecraft health documentation." }));
    expect(repository.removeDocument(stableSource.id, path)).toBe(true);
    expect(repository.removeDocument(stableSource.id, path)).toBe(false);
    expect(lexicalSearch(db, "health")).toHaveLength(0);
    const report = validateIndex(db);
    expect(report.documents).toBe(0);
    expect(report.chunks).toBe(0);
    expect(report.ftsRows).toBe(0);
  });

  it("detects missing and orphan FTS rows even when row counts match", () => {
    const db = database();
    const repository = new IndexRepository(db);
    repository.replaceDocument(ingestDocument({
      source: stableSource,
      path: "docs/test.md",
      content: "# Health\nMinecraft health documentation.",
    }));

    const chunk = db.prepare("SELECT id FROM chunks LIMIT 1").get() as { id: number } | undefined;
    expect(chunk).toBeDefined();
    db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(chunk?.id ?? -1);
    db.prepare(`
      INSERT INTO chunks_fts(rowid, identifier_text, title, heading, aliases, body, path)
      VALUES (999999, '', 'orphan', '', '', 'orphan', 'orphan')
    `).run();

    const report = validateIndex(db);
    expect(report.ftsRows).toBe(report.chunks);
    expect(report.ok).toBe(false);
    expect(report.missingFtsRows).toBe(1);
    expect(report.orphanFtsRows).toBe(1);
  });

  it("prefers a stable exact definition over an experimental preview equivalent", () => {
    const db = database();
    const repository = new IndexRepository(db);

    repository.replaceDocument(ingestDocument({
      source: previewSource,
      path: "creator/ScriptAPI/minecraft/server/SystemPreview.md",
      content: "# System Class\n## Methods\n::: moniker range=\"=minecraft-bedrock-experimental\"\n### **runInterval**\n`runInterval(callback: () => void): number;`\n::: moniker-end",
    }));
    repository.replaceDocument(ingestDocument({
      source: stableSource,
      path: "creator/ScriptAPI/minecraft/server/System.md",
      content: "# System Class\n## Methods\n### **runInterval**\n`runInterval(callback: () => void): number;`",
    }));

    const hits = exactIdentifierSearch(db, "System.runInterval");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.channel).toBe("stable");
    expect(hits[0]?.stability).toBe("stable");
  });

  it("does not let a preview primary identifier outrank a stable secondary exact match", () => {
    const db = database();
    const repository = new IndexRepository(db);

    repository.replaceDocument(ingestDocument({
      source: previewSource,
      path: "creator/ScriptAPI/minecraft/server/SystemPreview.md",
      content: "# System Class\n## Methods\n::: moniker range=\"=minecraft-bedrock-experimental\"\n### **runInterval**\n`runInterval(callback: () => void): number;`\n::: moniker-end",
    }));
    repository.replaceDocument(ingestDocument({
      source: stableSource,
      path: "creator/Documents/system-runinterval.md",
      content: "# Scheduling work\nUse `System.runInterval` to schedule repeating work.",
    }));

    const hits = exactIdentifierSearch(db, "System.runInterval");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.channel).toBe("stable");
    expect(hits[0]?.isPrimary).toBe(false);
    expect(hits[1]?.channel).toBe("preview");
    expect(hits[1]?.isPrimary).toBe(true);
  });

  it("allows a caller-owned transaction to roll back a clear-and-replace sequence", () => {
    const db = database();
    const repository = new IndexRepository(db);
    repository.replaceDocument(ingestDocument({
      source: stableSource,
      path: "behavior_pack/entities/example.json",
      content: JSON.stringify({ "minecraft:entity": { description: { identifier: "example:mob" }, components: { "minecraft:health": { value: 20 } } } }),
    }));

    db.exec("BEGIN IMMEDIATE");
    repository.clearIndex();
    repository.replaceDocument(ingestDocument({
      source: stableSource,
      path: "behavior_pack/entities/example.json",
      content: JSON.stringify({ "minecraft:entity": { description: { identifier: "example:mob" }, components: { "minecraft:movement": { value: 0.2 } } } }),
    }));
    db.exec("ROLLBACK");

    expect(exactIdentifierSearch(db, "minecraft:health")).toHaveLength(1);
    expect(exactIdentifierSearch(db, "minecraft:movement")).toHaveLength(0);
    expect(validateIndex(db).ok).toBe(true);
  });

  it("rejects search result limits outside bounded ranges", () => {
    const db = database();
    expect(() => exactIdentifierSearch(db, "minecraft:health", 0)).toThrow("between 1 and 50");
    expect(() => lexicalSearch(db, "health", 101)).toThrow("between 1 and 100");
  });

  it("compiles raw queries as quoted FTS terms instead of executable FTS syntax", () => {
    expect(compileFtsQuery('health OR "something"*')).toBe('"health" AND "OR" AND "something"');
    expect(() => compileFtsQuery("***")).toThrow("searchable text");
  });
});
