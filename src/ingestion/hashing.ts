import { createHash } from "node:crypto";

export function sha256Text(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
