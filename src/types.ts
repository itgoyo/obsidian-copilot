export type LoadState = "idle" | "loading" | "ready" | "error";

export interface OAuthToken {
  accessToken: string;
  tokenType: string;
  scope: string;
  createdAt: number;
}

export interface StoredOAuthToken {
  encryptedAccessToken: string;
  tokenType: string;
  scope: string;
  createdAt: number;
  /** true = Electron safeStorage, false/undefined = base64 fallback */
  isEncrypted?: boolean;
}

export interface DeviceAuthSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  requestedAt: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  multiplier?: string;
  contextWindow?: number;
  provider?: string;
}

export interface UsageInfo {
  status: "available" | "unavailable";
  summary?: string;
  resetAt?: string;
  raw?: unknown;
  reason?: string;
}

export interface CopilotViewState {
  authState: LoadState;
  dataState: LoadState;
  errorMessage?: string;
  username?: string;
  models: ModelInfo[];
  usage: UsageInfo;
  activeDeviceSession?: DeviceAuthSession;
  lastSyncedAt?: number;
  chatMessages: ChatMessage[];
  chatLoading: boolean;
}

export type ChatMode = "ask" | "agent" | "plan";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface CopilotPluginSettings {
  oauthClientId: string;
  oauthScopes: string;
  modelsEndpoint: string;
  usageEndpoint: string;
  /** One model per line: id|Display Name, supports JSON object lines as well */
  customModelsText: string;
  persistToken: boolean;
  selectedModelId: string;
  chatMode: ChatMode;
  token?: StoredOAuthToken;
  /** Migration flag: once set, old scope-based token clearing is skipped */
  tokenMigrated: boolean;
  chatSessions: ChatSession[];
  currentSessionId: string;
}

/** Short-lived Copilot session token obtained by exchanging GitHub OAuth token */
export interface CopilotSessionToken {
  token: string;
  expiresAt: number;
}
