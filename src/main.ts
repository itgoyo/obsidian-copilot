import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf
} from "obsidian";
import { GitHubOAuthDeviceFlow } from "./auth/githubOAuth";
import {
  BUILTIN_GITHUB_OAUTH_CLIENT_ID,
  DEFAULT_SETTINGS
} from "./settings";
import { GitHubApiClient } from "./services/githubApi";
import { ChatService } from "./services/chatService";
import type {
  ChatMessage,
  ChatSession,
  ModelInfo,
  CopilotPluginSettings,
  CopilotViewState,
  DeviceAuthSession,
  OAuthToken,
  StoredOAuthToken
} from "./types";
import {
  CopilotSidebarView,
  VIEW_TYPE_COPILOT_SIDEBAR
} from "./views/copilotSidebarView";

const EMPTY_VIEW_STATE: CopilotViewState = {
  authState: "idle",
  dataState: "idle",
  models: [],
  usage: {
    status: "unavailable",
    reason: "Sign in first to fetch usage."
  },
  chatMessages: [],
  chatLoading: false
};

const GITHUB_ALLOWED_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com"
]);

const DEFAULT_DEVICE_VERIFY_URL = "https://github.com/login/device";

function toSafeErrorMessage(error: unknown): string {
  const raw = String(error);
  const normalized = raw.toLowerCase();
  if (
    normalized.includes("incorrect_client_credentials") ||
    normalized.includes("unauthorized_client") ||
    normalized.includes("status 401")
  ) {
    return (
      "OAuth client configuration is invalid or unavailable. " +
      "Try setting your own OAuth Client ID in plugin settings."
    );
  }

  const escaped = raw.replace(/[<>'"&]/g, (char) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#x27;",
      '"': "&quot;",
      "&": "&amp;"
    };

    return entities[char] ?? char;
  });

  return escaped.slice(0, 500);
}

function isAllowedGitHubUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && GITHUB_ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function parseCustomModelsText(text: string): ModelInfo[] {
  if (!text.trim()) {
    return [];
  }

  const deduped = new Map<string, ModelInfo>();
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    // Supported formats:
    // 1) id|Display Name
    // 2) {"id":"...","name":"..."}
    let parsed: ModelInfo | undefined;

    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line) as Partial<ModelInfo>;
        const id = String(obj.id ?? "").trim();
        if (id) {
          parsed = {
            id,
            name: String(obj.name ?? id),
            provider: obj.provider,
            multiplier: obj.multiplier,
            contextWindow: obj.contextWindow
          };
        }
      } catch {
        // Ignore invalid JSON lines; keep processing remaining lines.
      }
    } else {
      const [idPart, ...nameParts] = line.split("|");
      const id = (idPart ?? "").trim();
      if (id) {
        const name = nameParts.join("|").trim() || id;
        parsed = { id, name };
      }
    }

    if (parsed) {
      deduped.set(parsed.id, parsed);
    }
  }

  return [...deduped.values()];
}

export default class CopilotOfficialSidebarPlugin extends Plugin {
  settings: CopilotPluginSettings = DEFAULT_SETTINGS;
  private sidebarView?: CopilotSidebarView;
  private viewState: CopilotViewState = { ...EMPTY_VIEW_STATE };
  private readonly oauth = new GitHubOAuthDeviceFlow();
  private pollingAbort?: AbortController;
  private chatAbort?: AbortController;
  private sessionToken?: OAuthToken;
  private chatService?: ChatService;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_COPILOT_SIDEBAR,
      (leaf: WorkspaceLeaf) => new CopilotSidebarView(leaf, this)
    );

    this.addRibbonIcon("bot", "Open Obsidian-Copilot", async () => {
      await this.activateView();
    });

    this.addCommand({
      id: "open-obsidian-copilot",
      name: "Open Obsidian-Copilot",
      callback: async () => {
        await this.activateView();
      }
    });

    this.addCommand({
      id: "copilot-sign-in",
      name: "Copilot Sign In",
      callback: async () => {
        await this.startLogin();
      }
    });

    this.addCommand({
      id: "copilot-refresh-metadata",
      name: "Copilot Refresh Models and Usage",
      callback: async () => {
        await this.refreshRemoteData();
      }
    });

    this.addSettingTab(new CopilotOfficialSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      await this.activateView();

      if (this.settings.token) {
        await this.refreshRemoteData();
      }
    });
  }

  async onunload(): Promise<void> {
    this.app.workspace
      .getLeavesOfType(VIEW_TYPE_COPILOT_SIDEBAR)
      .forEach((leaf) => leaf.detach());

    if (this.pollingAbort) {
      this.pollingAbort.abort();
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});

    // One-time migration: clear tokens from old OAuth App (GitHub CLI)
    if (!this.settings.tokenMigrated) {
      if (this.settings.token && this.settings.oauthScopes === "read:user") {
        this.settings.token = undefined;
        this.settings.oauthScopes = "";
      }
      this.settings.tokenMigrated = true;
      // Force-enable persistToken so users don't lose auth on restart
      this.settings.persistToken = true;
      await this.saveData(this.settings);
    }

    // Restore saved token
    if (this.settings.token) {
      const decrypted = this.decryptStoredToken(this.settings.token);
      if (decrypted) {
        this.sessionToken = decrypted;
        this.chatService = new ChatService(decrypted);
        // Mark auth as ready so sidebar shows chat screen while data loads
        this.viewState = {
          ...this.viewState,
          authState: "ready"
        };
      } else {
        this.settings.token = undefined;
      }
    }

    // Restore current session messages
    if (this.settings.currentSessionId) {
      const session = this.settings.chatSessions.find(
        s => s.id === this.settings.currentSessionId
      );
      if (session) {
        this.viewState.chatMessages = [...session.messages];
      }
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.sidebarView?.render();
  }

  getViewStateSnapshot(): CopilotViewState {
    return { ...this.viewState };
  }

  getCustomModels(): ModelInfo[] {
    return parseCustomModelsText(this.settings.customModelsText || "");
  }

  attachSidebarView(view: CopilotSidebarView): void {
    this.sidebarView = view;
  }

  detachSidebarView(view: CopilotSidebarView): void {
    if (this.sidebarView === view) {
      this.sidebarView = undefined;
    }
  }

  async activateView(): Promise<void> {
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_COPILOT_SIDEBAR)[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        throw new Error("Unable to create right sidebar leaf.");
      }

      await leaf.setViewState({
        type: VIEW_TYPE_COPILOT_SIDEBAR,
        active: true
      });
    }

    this.app.workspace.revealLeaf(leaf);
  }

  async startLogin(): Promise<void> {
    const clientId = this.getEffectiveOAuthClientId();

    this.viewState = {
      ...this.viewState,
      authState: "loading",
      errorMessage: undefined
    };
    this.sidebarView?.render();

    try {
      const session = await this.oauth.startDeviceAuthorization(
        clientId,
        this.settings.oauthScopes
      );

      this.viewState.activeDeviceSession = session;
      this.sidebarView?.render();

      const verifyUrl =
        session.verificationUriComplete ||
        session.verificationUri ||
        DEFAULT_DEVICE_VERIFY_URL;
      if (!isAllowedGitHubUrl(verifyUrl)) {
        throw new Error("Invalid verification URL from OAuth response.");
      }
      window.open(verifyUrl, "_blank", "noopener,noreferrer");
      new Notice(`Login code: ${session.userCode}. Paste it at github.com/login/device.`);

      if (this.pollingAbort) {
        this.pollingAbort.abort();
      }
      this.pollingAbort = new AbortController();

      const token = await this.oauth.pollForAccessToken(
        clientId,
        session,
        this.pollingAbort.signal
      );
      this.pollingAbort = undefined;

      // Always persist token after successful login
      this.settings.persistToken = true;
      await this.setToken(token);
      this.viewState.authState = "ready";
      this.viewState.activeDeviceSession = undefined;
      await this.refreshRemoteData();
      new Notice("GitHub authorization completed.");
    } catch (error) {
      this.viewState = {
        ...this.viewState,
        authState: "error",
        errorMessage: toSafeErrorMessage(error)
      };
      this.sidebarView?.render();
      throw error;
    }
  }

  async signOut(): Promise<void> {
    this.sessionToken = undefined;
    this.chatService = undefined;
    this.settings.token = undefined;
    await this.saveSettings();

    this.viewState = {
      ...EMPTY_VIEW_STATE,
      authState: "idle",
      dataState: "idle"
    };

    this.sidebarView?.render();
    new Notice("Signed out from plugin local session.");
  }

  async refreshRemoteData(): Promise<void> {
    const token = this.getEffectiveToken();
    if (!token) {
      this.viewState.dataState = "idle";
      this.viewState.models = [];
      this.viewState.usage = {
        status: "unavailable",
        reason: "Sign in first to fetch usage."
      };
      this.sidebarView?.render();
      return;
    }

    this.viewState = {
      ...this.viewState,
      dataState: "loading",
      errorMessage: undefined
    };
    this.sidebarView?.render();

    try {
      const apiClient = new GitHubApiClient(token);

      // Set username FIRST — so partial failures in models/usage don't lose login
      const username = await apiClient.getAuthenticatedUser();
      this.viewState.username = username;
      this.viewState.authState = "ready";

      // Models and usage are non-critical; failures are tolerated
      let models: import("./types").ModelInfo[] = [];
      let usage: import("./types").UsageInfo = {
        status: "unavailable",
        reason: "Could not fetch usage data."
      };

      try {
        [models, usage] = await Promise.all([
          apiClient.getModels(this.settings.modelsEndpoint),
          apiClient.getUsage(this.settings.usageEndpoint)
        ]);
      } catch {
        // Non-critical: keep username but note data fetch partial failure
      }

      this.viewState.models = models;
      this.viewState.usage = usage;
      this.viewState.dataState = "ready";
      this.viewState.lastSyncedAt = Date.now();
    } catch (error) {
      const errMsg = String(error).toLowerCase();
      const isAuthError =
        errMsg.includes("status 401") || errMsg.includes("status 403");

      if (isAuthError && this.sessionToken) {
        // Token expired or revoked — clear and prompt re-login
        this.sessionToken = undefined;
        this.settings.token = undefined;
        await this.saveData(this.settings);
        this.viewState = {
          ...EMPTY_VIEW_STATE,
          authState: "idle",
          errorMessage: "Session expired. Please sign in again."
        };
      } else {
        this.viewState = {
          ...this.viewState,
          dataState: "error",
          errorMessage: toSafeErrorMessage(error)
        };
      }
    }

    this.sidebarView?.render();
  }

  async sendChatMessage(content: string): Promise<void> {
    const token = this.getEffectiveToken();
    if (!token) {
      new Notice("Sign in first to use Obsidian-Copilot.");
      return;
    }

    const modelId = this.settings.selectedModelId || "gpt-4o";

    const userMsg: ChatMessage = {
      role: "user",
      content,
      timestamp: Date.now()
    };
    this.viewState.chatMessages = [...this.viewState.chatMessages, userMsg];
    this.viewState.chatLoading = true;
    this.sidebarView?.render();

    // Reuse ChatService to keep Copilot session token cached
    if (!this.chatService && token) {
      this.chatService = new ChatService(token);
    }
    const chatService = this.chatService!;

    this.chatAbort = new AbortController();
    let fullResponse = "";

    try {
      fullResponse = await chatService.sendMessage(
        this.viewState.chatMessages,
        modelId,
        this.settings.chatMode,
        (chunk: string) => {
          this.sidebarView?.appendStreamChunk(chunk);
        },
        this.chatAbort.signal
      );
    } catch (error) {
      if (this.chatAbort?.signal.aborted) {
        fullResponse = fullResponse || "(Stopped)";
      } else {
        fullResponse = `Error: ${String(error).slice(0, 300)}`;
      }
    }

    this.chatAbort = undefined;

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: fullResponse,
      timestamp: Date.now()
    };
    this.viewState.chatMessages = [...this.viewState.chatMessages, assistantMsg];
    this.viewState.chatLoading = false;

    this.sidebarView?.finalizeStreamMessage();
    this.sidebarView?.render();

    // Auto-save current session
    this.persistCurrentSession();
  }

  clearChat(): void {
    // Save current session before clearing (if it has messages)
    this.persistCurrentSession();

    // Start a fresh session
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.settings.currentSessionId = newId;
    this.viewState.chatMessages = [];
    this.viewState.chatLoading = false;
    if (this.chatAbort) {
      this.chatAbort.abort();
      this.chatAbort = undefined;
    }
    this.saveData(this.settings);
    this.sidebarView?.render();
  }

  /** Persist current chat messages into the sessions list */
  private persistCurrentSession(): void {
    if (this.viewState.chatMessages.length === 0) return;

    let sessionId = this.settings.currentSessionId;
    if (!sessionId) {
      sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      this.settings.currentSessionId = sessionId;
    }

    const firstUserMsg = this.viewState.chatMessages.find(m => m.role === "user");
    const title = firstUserMsg
      ? firstUserMsg.content.slice(0, 60).replace(/\n/g, " ")
      : "New Chat";

    const existing = this.settings.chatSessions.findIndex(s => s.id === sessionId);
    const session: ChatSession = {
      id: sessionId,
      title,
      messages: [...this.viewState.chatMessages],
      createdAt: existing >= 0 ? this.settings.chatSessions[existing].createdAt : Date.now(),
      updatedAt: Date.now()
    };

    if (existing >= 0) {
      this.settings.chatSessions[existing] = session;
    } else {
      this.settings.chatSessions.push(session);
    }

    // Keep max 50 sessions
    if (this.settings.chatSessions.length > 50) {
      this.settings.chatSessions = this.settings.chatSessions
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50);
    }

    this.saveData(this.settings);
  }

  /** Load a previous chat session by ID */
  loadSession(sessionId: string): void {
    // Save current first
    this.persistCurrentSession();

    const session = this.settings.chatSessions.find(s => s.id === sessionId);
    if (!session) return;

    this.settings.currentSessionId = session.id;
    this.viewState.chatMessages = [...session.messages];
    this.viewState.chatLoading = false;
    if (this.chatAbort) {
      this.chatAbort.abort();
      this.chatAbort = undefined;
    }
    this.saveData(this.settings);
    this.sidebarView?.render();
  }

  /** Delete a session by ID */
  deleteSession(sessionId: string): void {
    this.settings.chatSessions = this.settings.chatSessions.filter(s => s.id !== sessionId);
    // If we deleted the current session, reset
    if (this.settings.currentSessionId === sessionId) {
      this.settings.currentSessionId = "";
      this.viewState.chatMessages = [];
    }
    this.saveData(this.settings);
    this.sidebarView?.render();
  }

  /** Get sorted sessions (newest first) */
  getChatSessions(): ChatSession[] {
    return [...this.settings.chatSessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  stopChat(): void {
    if (this.chatAbort) {
      this.chatAbort.abort();
      this.chatAbort = undefined;
    }
  }

  private async setToken(token: OAuthToken): Promise<void> {
    this.sessionToken = token;
    this.chatService = new ChatService(token);
    if (this.settings.persistToken) {
      this.settings.token = this.encryptTokenForStorage(token);
    } else {
      this.settings.token = undefined;
    }
    await this.saveSettings();
  }

  private getEffectiveToken(): OAuthToken | undefined {
    return this.sessionToken;
  }

  private getEffectiveOAuthClientId(): string {
    const customClientId = this.settings.oauthClientId.trim();
    if (customClientId) {
      return customClientId;
    }

    const builtInClientId = BUILTIN_GITHUB_OAUTH_CLIENT_ID;
    if (!builtInClientId) {
      throw new Error(
        "Built-in OAuth Client ID is not configured. Set a custom Client ID in settings."
      );
    }

    return builtInClientId;
  }

  private getSafeStorage():
    | {
        isEncryptionAvailable: () => boolean;
        encryptString: (value: string) => Buffer;
        decryptString: (value: Buffer) => string;
      }
    | undefined {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electronModule = require("electron") as {
        safeStorage?: {
          isEncryptionAvailable: () => boolean;
          encryptString: (value: string) => Buffer;
          decryptString: (value: Buffer) => string;
        };
      };

      return electronModule.safeStorage;
    } catch {
      return undefined;
    }
  }

  private encryptTokenForStorage(token: OAuthToken): StoredOAuthToken {
    const safeStorage = this.getSafeStorage();
    if (safeStorage?.isEncryptionAvailable()) {
      return {
        encryptedAccessToken: safeStorage
          .encryptString(token.accessToken)
          .toString("base64"),
        tokenType: token.tokenType,
        scope: token.scope,
        createdAt: token.createdAt,
        isEncrypted: true
      };
    }

    // Fallback: base64 encode (stored locally in vault data)
    return {
      encryptedAccessToken: btoa(token.accessToken),
      tokenType: token.tokenType,
      scope: token.scope,
      createdAt: token.createdAt,
      isEncrypted: false
    };
  }

  private decryptStoredToken(stored: StoredOAuthToken): OAuthToken | undefined {
    // Base64 fallback path (isEncrypted === false or undefined for legacy tokens)
    if (stored.isEncrypted === false) {
      try {
        return {
          accessToken: atob(stored.encryptedAccessToken),
          tokenType: stored.tokenType,
          scope: stored.scope,
          createdAt: stored.createdAt
        };
      } catch {
        return undefined;
      }
    }

    // Electron safeStorage path
    const safeStorage = this.getSafeStorage();
    if (!safeStorage?.isEncryptionAvailable()) {
      return undefined;
    }

    try {
      const accessToken = safeStorage.decryptString(
        Buffer.from(stored.encryptedAccessToken, "base64")
      );

      return {
        accessToken,
        tokenType: stored.tokenType,
        scope: stored.scope,
        createdAt: stored.createdAt
      };
    } catch {
      return undefined;
    }
  }
}

class CopilotOfficialSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CopilotOfficialSidebarPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", {
      text: "Obsidian-Copilot Settings"
    });

    new Setting(containerEl)
      .setName("Custom GitHub OAuth Client ID (optional)")
      .setDesc(
        "Leave empty to use built-in device login. Set this only if you want to use your own OAuth App."
      )
      .addText((text) =>
        text
          .setPlaceholder("OAuth client ID (advanced)")
          .setValue(this.plugin.settings.oauthClientId)
          .onChange(async (value) => {
            this.plugin.settings.oauthClientId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("OAuth scopes")
      .setDesc("Scopes requested in device flow. Keep minimal permissions.")
      .addText((text) =>
        text
          .setPlaceholder("read:user")
          .setValue(this.plugin.settings.oauthScopes)
          .onChange(async (value) => {
            this.plugin.settings.oauthScopes = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Models endpoint")
      .setDesc("Official API endpoint for account-available Copilot models.")
      .addText((text) =>
        text
          .setPlaceholder("https://api.github.com/copilot/models")
          .setValue(this.plugin.settings.modelsEndpoint)
          .onChange(async (value) => {
            const endpoint = value.trim();
            if (!isAllowedGitHubUrl(endpoint)) {
              new Notice("Endpoint must be https and under official GitHub hosts.");
              return;
            }
            this.plugin.settings.modelsEndpoint = endpoint;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Usage endpoint")
      .setDesc("Official API endpoint for usage/quota metadata.")
      .addText((text) =>
        text
          .setPlaceholder("https://api.github.com/user/copilot/usage")
          .setValue(this.plugin.settings.usageEndpoint)
          .onChange(async (value) => {
            const endpoint = value.trim();
            if (!isAllowedGitHubUrl(endpoint)) {
              new Notice("Endpoint must be https and under official GitHub hosts.");
              return;
            }
            this.plugin.settings.usageEndpoint = endpoint;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Custom models (optional)")
      .setDesc(
        "Fallback only when official model API is unavailable. One model per line: id|Display Name"
      )
      .addTextArea((text) => {
        text
          .setPlaceholder(
            [
              "gpt-5.3-codex|GPT-5.3-Codex",
              "claude-opus-4.6|Claude Opus 4.6",
              '# JSON line also works: {"id":"model-id","name":"Model Name"}'
            ].join("\n")
          )
          .setValue(this.plugin.settings.customModelsText || "")
          .onChange(async (value) => {
            this.plugin.settings.customModelsText = value;
            await this.plugin.saveSettings();
          });

        text.inputEl.rows = 6;
        text.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Persist token in vault")
      .setDesc(
        "If disabled, token is only kept in current app session. If enabled, plugin stores encrypted token when desktop secure storage is available."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.persistToken).onChange(async (value) => {
          this.plugin.settings.persistToken = value;
          if (!value) {
            this.plugin.settings.token = undefined;
          }
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Open right sidebar panel")
      .setDesc("Open the plugin sidebar panel immediately.")
      .addButton((button) =>
        button.setButtonText("Open").onClick(async () => {
          await this.plugin.activateView();
        })
      );

    new Setting(containerEl)
      .setName("Clear local token")
      .setDesc("Remove locally stored access token from this vault.")
      .addButton((button) =>
        button.setWarning().setButtonText("Clear").onClick(async () => {
          await this.plugin.signOut();
          new Notice("Token removed from plugin storage.");
        })
      );
  }
}
