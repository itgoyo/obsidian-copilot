import { requestUrl } from "obsidian";
import type { ModelInfo, OAuthToken, UsageInfo } from "../types";

interface RequestOptions {
  method?: "GET" | "POST";
  body?: string;
}

const FETCH_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

const MODEL_ENDPOINT_CANDIDATES = [
  "https://api.github.com/copilot/models",
  "https://api.github.com/models"
];

const USAGE_ENDPOINT_CANDIDATES = [
  "https://api.github.com/user/copilot/usage",
  "https://api.github.com/copilot/usage",
  "https://api.github.com/user/billing/copilot"
];

function extractArrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;

    if (Array.isArray(objectValue.models)) {
      return objectValue.models;
    }

    if (Array.isArray(objectValue.data)) {
      return objectValue.data;
    }
  }

  return [];
}

function normalizeModel(item: unknown): ModelInfo | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const record = item as Record<string, unknown>;

  const id = String(record.id ?? record.name ?? "").trim();
  if (!id) {
    return undefined;
  }

  const name = String(record.name ?? id);
  const provider =
    typeof record.provider === "string" ? record.provider : undefined;

  const contextWindowValue =
    typeof record.context_window === "number"
      ? record.context_window
      : typeof record.max_input_tokens === "number"
      ? record.max_input_tokens
      : undefined;

  const multiplierRaw =
    record.multiplier ??
    record.rate_multiplier ??
    record.x_multiplier ??
    record.usage_multiplier;

  const multiplier =
    typeof multiplierRaw === "number"
      ? `x${multiplierRaw}`
      : typeof multiplierRaw === "string"
      ? multiplierRaw.startsWith("x")
        ? multiplierRaw
        : `x${multiplierRaw}`
      : undefined;

  return {
    id,
    name,
    provider,
    contextWindow: contextWindowValue,
    multiplier
  };
}

export class GitHubApiClient {
  constructor(private readonly token: OAuthToken) {}

  private async requestJson(url: string, options?: RequestOptions): Promise<unknown> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        let timer: number | undefined;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timer = window.setTimeout(() => {
            reject(new Error("GitHub API request timed out."));
          }, FETCH_TIMEOUT_MS);
        });

        const reqPromise = requestUrl({
          url,
          method: options?.method ?? "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.token.accessToken}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(options?.body ? { "Content-Type": "application/json" } : {})
          },
          body: options?.body,
          throw: false
        });

        const response = await Promise.race([reqPromise, timeoutPromise]);
        if (timer !== undefined) window.clearTimeout(timer);

        if (response.status < 200 || response.status >= 300) {
          const isRetryable = response.status === 429 || response.status >= 500;
          if (isRetryable && attempt < MAX_RETRIES) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, 1000 * (attempt + 1))
            );
            continue;
          }

          throw new Error(`GitHub API request failed with status ${response.status}`);
        }

        return response.json;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("GitHub API request failed.");
  }

  async getAuthenticatedUser(): Promise<string> {
    const payload = (await this.requestJson("https://api.github.com/user")) as {
      login?: string;
    };

    if (!payload.login) {
      throw new Error("Unable to resolve GitHub username from token.");
    }

    return payload.login;
  }

  async getModels(preferredEndpoint: string): Promise<ModelInfo[]> {
    const candidates = [preferredEndpoint, ...MODEL_ENDPOINT_CANDIDATES].filter(Boolean);
    const uniqueCandidates = [...new Set(candidates)];

    for (const endpoint of uniqueCandidates) {
      try {
        const payload = await this.requestJson(endpoint);
        const models = extractArrayPayload(payload)
          .map((item) => normalizeModel(item))
          .filter((item): item is ModelInfo => Boolean(item));

        if (models.length > 0) {
          return models;
        }
      } catch {
        continue;
      }
    }

    return [];
  }

  async getUsage(preferredEndpoint: string): Promise<UsageInfo> {
    const candidates = [preferredEndpoint, ...USAGE_ENDPOINT_CANDIDATES].filter(Boolean);
    const uniqueCandidates = [...new Set(candidates)];

    for (const endpoint of uniqueCandidates) {
      try {
        const payload = await this.requestJson(endpoint);

        const summary =
          typeof payload === "object" && payload
            ? JSON.stringify(payload)
            : "Usage data available";

        return {
          status: "available",
          summary,
          raw: payload
        };
      } catch {
        continue;
      }
    }

    return {
      status: "unavailable",
      reason:
        "Official API does not provide personal Copilot usage for this account token or scope."
    };
  }
}
