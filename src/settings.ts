import type { CopilotPluginSettings } from "./types";

// Built-in OAuth App client ID for Copilot device flow login.
// This is the official GitHub Copilot OAuth App used by VS Code, Neovim, etc.
export const BUILTIN_GITHUB_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export const DEFAULT_SETTINGS: CopilotPluginSettings = {
  oauthClientId: "",
  oauthScopes: "",
  modelsEndpoint: "https://api.github.com/copilot/models",
  usageEndpoint: "https://api.github.com/user/copilot/usage",
  customModelsText: "",
  persistToken: true,
  selectedModelId: "",
  chatMode: "ask",
  tokenMigrated: false,
  chatSessions: [],
  currentSessionId: ""
};
