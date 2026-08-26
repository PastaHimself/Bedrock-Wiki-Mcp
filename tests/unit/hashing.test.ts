import { describe, expect, it } from "vitest";
import { sha256Text } from "../../src/ingestion/hashing.js";

describe("content hashing", () => {
  it("produces deterministic SHA-256 hashes", () => {
    expect(sha256Text("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Text("abc")).toBe(sha256Text("abc"));
    expect(sha256Text("abc")).not.toBe(sha256Text("abcd"));
  });
});
