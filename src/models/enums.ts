export type DocumentKind =
  | "docs"
  | "api"
  | "component"
  | "json"
  | "code"
  | "example"
  | "reference";

export type Stability = "stable" | "beta" | "experimental" | "internal" | "unknown";
export type Lifecycle = "active" | "deprecated" | "removed" | "historical" | "unknown";
export type ReleaseChannel = "stable" | "preview" | "unknown";

export type ChunkType =
  | "document"
  | "section"
  | "api-overview"
  | "api-member"
  | "json-object"
  | "code-block";

export type SymbolKind =
  | "class"
  | "interface"
  | "method"
  | "property"
  | "event"
  | "enum"
  | "component"
  | "animation"
  | "animation-controller"
  | "render-controller"
  | "function"
  | "class-code"
  | "event-handler"
  | "unknown";
