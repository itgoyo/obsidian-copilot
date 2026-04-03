import { requestUrl } from "obsidian";
import type { ChatMessage, ChatMode, CopilotSessionToken, OAuthToken } from "../types";

/**
 * Copilot token exchange endpoint.
 * The GitHub OAuth token must be exchanged for a short-lived Copilot session
 * token before calling the chat completions API.
 */
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

/**
 * The actual chat completions endpoint (OpenAI-compatible).
 * Requires the Copilot session token, NOT the GitHub OAuth token.
 */
const COPILOT_CHAT_URL = "https://api.githubcopilot.com/chat/completions";

/** Buffer (ms) before treating cached copilot token as expired */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

function buildSystemPrompt(mode: ChatMode): string {
  switch (mode) {
    case "agent":
      return (
        "You are a helpful AI coding agent inside Obsidian. " +
        "Help the user with any task: writing, editing, searching, organizing notes, coding, and more. " +
        "Be proactive and provide actionable answers."
      );
    case "plan":
      return (
        "You are a planning assistant inside Obsidian. " +
        "When the user describes a task, break it into clear numbered steps. " +
        "Provide a structured plan with phases, dependencies, and concrete actions."
      );
    case "ask":
    default:
      return (
        "You are a helpful AI assistant inside Obsidian. " +
        "Answer the user's questions clearly and concisely. " +
        "When appropriate, provide code examples or structured explanations."
      );
  }
}

interface ChatCompletionChoice {
  delta?: { content?: string };
  message?: { content?: string };
  finish_reason?: string | null;
}

interface ChatCompletionChunk {
  choices?: ChatCompletionChoice[];
}

function generateRequestId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class ChatService {
  private cachedCopilotToken?: CopilotSessionToken;

  constructor(private readonly oauthToken: OAuthToken) {}

  /**
   * Exchange the GitHub OAuth token for a short-lived Copilot session token.
   * Caches the result and reuses until expiry.
   */
  async getCopilotToken(): Promise<string> {
    if (
      this.cachedCopilotToken &&
      Date.now() < this.cachedCopilotToken.expiresAt - TOKEN_EXPIRY_BUFFER_MS
    ) {
      return this.cachedCopilotToken.token;
    }

    const response = await requestUrl({
      url: COPILOT_TOKEN_URL,
      method: "GET",
      headers: {
        Authorization: `token ${this.oauthToken.accessToken}`,
        Accept: "application/json"
      },
      throw: false
    });

    if (response.status < 200 || response.status >= 300) {
      const hint =
        response.status === 401
          ? "OAuth token may be invalid or expired. Try signing out and back in."
          : response.status === 403
          ? "Your GitHub account may not have Copilot access."
          : `Unexpected status ${response.status}`;
      throw new Error(`Failed to get Copilot token: ${hint}`);
    }

    const data = response.json as {
      token?: string;
      expires_at?: number;
    };

    if (!data.token) {
      throw new Error("Copilot token response missing token field.");
    }

    this.cachedCopilotToken = {
      token: data.token,
      expiresAt: typeof data.expires_at === "number"
        ? data.expires_at * 1000
        : Date.now() + 30 * 60 * 1000
    };

    return this.cachedCopilotToken.token;
  }

  async sendMessage(
    messages: ChatMessage[],
    modelId: string,
    mode: ChatMode,
    onChunk: (text: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    // Step 1: obtain copilot session token
    const copilotToken = await this.getCopilotToken();

    const systemMsg = buildSystemPrompt(mode);
    const apiMessages = [
      { role: "system" as const, content: systemMsg },
      ...messages.map((m) => ({ role: m.role, content: m.content }))
    ];

    const body = JSON.stringify({
      model: modelId,
      messages: apiMessages,
      stream: true
    });

    const headers = {
      Authorization: `Bearer ${copilotToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Editor-Version": "obsidian/1.0.0",
      "Editor-Plugin-Version": "copilot-obsidian/1.0.0",
      "Copilot-Integration-Id": "vscode-chat",
      "Openai-Intent": "conversation-panel",
      "X-Request-Id": generateRequestId()
    };

    // Try streaming with native fetch first, fall back to non-streaming requestUrl.
    try {
      return await this.streamWithFetch(COPILOT_CHAT_URL, headers, body, onChunk, signal);
    } catch {
      return await this.fallbackNonStreaming(COPILOT_CHAT_URL, copilotToken, body, onChunk);
    }
  }

  private async streamWithFetch(
    url: string,
    headers: Record<string, string>,
    body: string,
    onChunk: (text: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Chat API returned ${response.status}: ${text.slice(0, 200)}`);
    }

    return await this.readSSEStream(response, onChunk);
  }

  private async readSSEStream(
    response: Response,
    onChunk: (text: string) => void
  ): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body is not readable.");
    }

    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;

        const payload = trimmed.slice(6);
        if (payload === "[DONE]") break;

        try {
          const chunk = JSON.parse(payload) as ChatCompletionChunk;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onChunk(delta);
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    return fullText;
  }

  private async fallbackNonStreaming(
    url: string,
    copilotToken: string,
    body: string,
    onChunk: (text: string) => void
  ): Promise<string> {
    const nonStreamBody = JSON.parse(body) as Record<string, unknown>;
    nonStreamBody.stream = false;
    const payload = JSON.stringify(nonStreamBody);

    const response = await requestUrl({
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Editor-Version": "obsidian/1.0.0",
        "Editor-Plugin-Version": "copilot-obsidian/1.0.0",
        "Copilot-Integration-Id": "vscode-chat",
        "Openai-Intent": "conversation-panel",
        "X-Request-Id": generateRequestId()
      },
      body: payload,
      throw: false
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Chat API returned ${response.status}`);
    }

    const data = response.json as ChatCompletionChunk | undefined;
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.delta?.content ??
      "";

    if (content) {
      onChunk(content);
    }
    return content;
  }
}
