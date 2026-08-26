import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "../config.js";

const RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 4_096;

export interface GuardRejection {
  statusCode: number;
  error: string;
  retryAfterSeconds?: number;
}

export interface GuardPermit {
  release(): void;
}

interface WindowCounter {
  startedAt: number;
  count: number;
}

function hostAllowed(host: string | undefined, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true;
  if (!host) return false;
  return allowedHosts.includes(host.toLocaleLowerCase());
}

function originAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin || allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin.replace(/\/$/, ""));
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export class HttpRequestGuard {
  readonly #config: Pick<AppConfig, "allowedHosts" | "allowedOrigins" | "bearerToken" | "maxConcurrentRequests" | "rateLimitPerMinute">;
  readonly #rateWindows = new Map<string, WindowCounter>();
  #activeRequests = 0;

  constructor(config: AppConfig) {
    this.#config = config;
  }

  #pruneRateWindows(now: number): void {
    if (this.#rateWindows.size < MAX_TRACKED_CLIENTS) return;
    for (const [key, window] of this.#rateWindows) {
      if (now - window.startedAt >= RATE_WINDOW_MS) this.#rateWindows.delete(key);
    }
    while (this.#rateWindows.size >= MAX_TRACKED_CLIENTS) {
      const oldestKey = this.#rateWindows.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.#rateWindows.delete(oldestKey);
    }
  }

  enter(request: IncomingMessage): GuardRejection | GuardPermit {
    if (!hostAllowed(request.headers.host, this.#config.allowedHosts)) {
      return { statusCode: 403, error: "host_not_allowed" };
    }

    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (!originAllowed(origin, this.#config.allowedOrigins)) {
      return { statusCode: 403, error: "origin_not_allowed" };
    }

    const now = Date.now();
    const clientKey = request.socket.remoteAddress ?? "unknown";
    let window = this.#rateWindows.get(clientKey);
    if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
      this.#pruneRateWindows(now);
      window = { startedAt: now, count: 0 };
      this.#rateWindows.set(clientKey, window);
    }
    window.count += 1;
    if (window.count > this.#config.rateLimitPerMinute) {
      const retryAfterSeconds = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - window.startedAt)) / 1000));
      return { statusCode: 429, error: "rate_limited", retryAfterSeconds };
    }

    if (this.#config.bearerToken) {
      const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
      if (!bearerMatches(authorization, this.#config.bearerToken)) {
        return { statusCode: 401, error: "unauthorized" };
      }
    }

    if (this.#activeRequests >= this.#config.maxConcurrentRequests) {
      return { statusCode: 503, error: "server_busy" };
    }

    this.#activeRequests += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#activeRequests = Math.max(0, this.#activeRequests - 1);
      },
    };
  }
}
