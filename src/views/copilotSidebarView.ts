import {
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Notice,
  setIcon,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import type CopilotOfficialSidebarPlugin from "../main";
import type { ChatMode, ChatSession, ModelInfo } from "../types";

export const VIEW_TYPE_COPILOT_SIDEBAR = "obsidian-copilot-sidebar-view";

const MODE_LABELS: Record<ChatMode, string> = {
  ask: "Ask",
  agent: "Agent",
  plan: "Plan"
};

/* ---- File / Note suggestion modals ---- */

class VaultFileSuggestModal extends FuzzySuggestModal<TFile> {
  private callback: (file: TFile) => void;
  constructor(plugin: CopilotOfficialSidebarPlugin, callback: (file: TFile) => void) {
    super(plugin.app);
    this.callback = callback;
    this.setPlaceholder("Search files to attach...");
  }
  getItems(): TFile[] { return this.app.vault.getFiles(); }
  getItemText(item: TFile): string { return item.path; }
  onChooseItem(item: TFile): void { this.callback(item); }
}

class VaultNoteSuggestModal extends FuzzySuggestModal<TFile> {
  private callback: (file: TFile) => void;
  constructor(plugin: CopilotOfficialSidebarPlugin, callback: (file: TFile) => void) {
    super(plugin.app);
    this.callback = callback;
    this.setPlaceholder("Search notes to reference...");
  }
  getItems(): TFile[] { return this.app.vault.getMarkdownFiles(); }
  getItemText(item: TFile): string { return item.basename; }
  onChooseItem(item: TFile): void { this.callback(item); }
}

export class CopilotSidebarView extends ItemView {
  private messagesContainer?: HTMLElement;
  private inputEl?: HTMLTextAreaElement;
  private streamingEl?: HTMLElement;
  private attachedFiles: TFile[] = [];
  private referencedNotes: TFile[] = [];
  private attachBadgeEl?: HTMLElement;
  private refBadgeEl?: HTMLElement;
  private contextBarEl?: HTMLElement;
  private showingHistory = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: CopilotOfficialSidebarPlugin
  ) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_COPILOT_SIDEBAR; }
  getDisplayText(): string { return "Obsidian-Copilot"; }
  getIcon(): string { return "bot"; }

  async onOpen(): Promise<void> {
    this.plugin.attachSidebarView(this);
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.detachSidebarView(this);
  }

  appendStreamChunk(text: string): void {
    if (!this.streamingEl) return;
    this.streamingEl.textContent += text;
    this.scrollToBottom();
  }

  finalizeStreamMessage(): void {
    if (!this.streamingEl) return;
    const content = this.streamingEl.textContent ?? "";
    this.streamingEl.empty();
    this.streamingEl.removeClass("copilot-streaming");
    MarkdownRenderer.render(this.plugin.app, content, this.streamingEl, "", this.plugin);
    this.streamingEl = undefined;
    this.scrollToBottom();
  }

  render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("copilot-sidebar-root");

    const state = this.plugin.getViewStateSnapshot();

    if (state.username || state.authState === "ready") {
      this.renderChatScreen(contentEl);
      return;
    }
    this.renderLoginScreen(contentEl);
  }

  /* ========== Login screen ========== */

  private renderLoginScreen(container: HTMLElement): void {
    const state = this.plugin.getViewStateSnapshot();
    const wrapper = container.createDiv({ cls: "copilot-login-screen" });

    const avatarWrap = wrapper.createDiv({ cls: "copilot-login-avatar" });
    avatarWrap.createSpan({ text: "✦", cls: "copilot-login-avatar-icon" });

    wrapper.createEl("h2", { text: "GitHub Copilot", cls: "copilot-login-title" });
    wrapper.createDiv({ text: "Sign in with GitHub to start chatting", cls: "copilot-login-hint" });

    if (state.errorMessage) {
      wrapper.createDiv({ text: state.errorMessage, cls: "copilot-error" });
    }

    if (state.activeDeviceSession) {
      const device = wrapper.createDiv({ cls: "copilot-device" });
      device.createDiv({ text: "Enter this code on GitHub:", cls: "copilot-device-label" });

      const codeRow = device.createDiv({ cls: "copilot-copyable-row" });
      codeRow.createDiv({ text: state.activeDeviceSession.userCode, cls: "copilot-device-code" });
      const copyCodeBtn = codeRow.createEl("button", { text: "Copy", cls: "copilot-copy-btn" });
      copyCodeBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(state.activeDeviceSession!.userCode);
        copyCodeBtn.textContent = "✓";
        window.setTimeout(() => { copyCodeBtn.textContent = "Copy"; }, 1500);
      });

      const verifyUrl = state.activeDeviceSession.verificationUri || "https://github.com/login/device";
      const urlRow = device.createDiv({ cls: "copilot-copyable-row" });
      const urlLink = urlRow.createEl("a", { text: verifyUrl, href: verifyUrl, cls: "copilot-device-url" });
      urlLink.setAttr("target", "_blank");
      urlLink.setAttr("rel", "noopener noreferrer");
      const copyUrlBtn = urlRow.createEl("button", { text: "Copy", cls: "copilot-copy-btn" });
      copyUrlBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(verifyUrl);
        copyUrlBtn.textContent = "✓";
        window.setTimeout(() => { copyUrlBtn.textContent = "Copy"; }, 1500);
      });
    }

    const btn = wrapper.createEl("button", {
      text: state.authState === "loading" ? "Signing in..." : "Sign in with GitHub",
      cls: "copilot-primary-btn copilot-login-btn"
    });
    btn.disabled = state.authState === "loading";
    if (state.authState === "loading") btn.addClass("copilot-btn-loading");
    btn.addEventListener("click", async () => {
      try { await this.plugin.startLogin(); }
      catch (error) { new Notice(String(error)); }
    });
  }

  /* ========== Chat screen ========== */

  private renderChatScreen(container: HTMLElement): void {
    const state = this.plugin.getViewStateSnapshot();
    const currentMode = this.plugin.settings.chatMode || "ask";

    /* --- Sub-header: ✦ Model ▾ | 🕓 ＋ --- */
    const subHeader = container.createDiv({ cls: "copilot-subheader" });

    // Left: model selector
    const modelBtn = subHeader.createDiv({ cls: "copilot-model-selector" });
    modelBtn.createSpan({ text: "✦", cls: "copilot-model-icon" });

    const defaultModels: ModelInfo[] = [
      { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
      { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
      { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
      { id: "claude-opus-4.6-fast", name: "Claude Opus 4.6 (fast mode) (Preview)" },
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      { id: "gpt-4.1", name: "GPT-4.1" },
      { id: "gpt-5-mini", name: "GPT-5 mini" },
      { id: "gpt-5.1", name: "GPT-5.1" },
      { id: "gpt-5.2", name: "GPT-5.2" },
      { id: "gpt-5.2-codex", name: "GPT-5.2-Codex" },
      { id: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { id: "gpt-4.1-nano", name: "GPT-4.1 Nano" },
      { id: "o4-mini", name: "o4-mini" },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-3-flash", name: "Gemini 3 Flash (Preview)" },
      { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro (Preview)" },
      { id: "grok-code-fast-1", name: "Grok Code Fast 1" },
      { id: "raptor-mini", name: "Raptor mini (Preview)" }
    ];
    const allModels = defaultModels;
    const selectedModelId = this.plugin.settings.selectedModelId || allModels[0]?.id;

    const modelSelect = modelBtn.createEl("select", { cls: "copilot-model-select" });
    for (const model of allModels) {
      const opt = modelSelect.createEl("option", { text: model.name, value: model.id });
      if (model.id === selectedModelId) opt.selected = true;
    }
    modelSelect.addEventListener("change", async () => {
      this.plugin.settings.selectedModelId = modelSelect.value;
      await this.plugin.saveSettings();
    });

    // Dropdown chevron hint
    const chevron = modelBtn.createSpan({ cls: "copilot-model-chevron" });
    setIcon(chevron, "chevron-down");

    // Right: history + new chat
    const actions = subHeader.createDiv({ cls: "copilot-subheader-actions" });

    const historyBtn = actions.createEl("button", { cls: "copilot-header-btn", attr: { title: "History" } });
    setIcon(historyBtn, "clock");
    historyBtn.addEventListener("click", () => {
      this.showingHistory = !this.showingHistory;
      this.render();
    });

    const newChatBtn = actions.createEl("button", { cls: "copilot-header-btn copilot-header-btn-primary", attr: { title: "New Chat" } });
    setIcon(newChatBtn, "plus");
    newChatBtn.addEventListener("click", () => {
      this.showingHistory = false;
      this.plugin.clearChat();
    });

    /* --- If showing history panel, render that instead of chat --- */
    if (this.showingHistory) {
      this.renderHistoryPanel(container);
      return;
    }

    /* --- Messages area --- */
    const messagesArea = container.createDiv({ cls: "copilot-messages" });
    this.messagesContainer = messagesArea;

    if (state.chatMessages.length === 0) {
      const empty = messagesArea.createDiv({ cls: "copilot-empty-chat" });
      const emptyAvatar = empty.createDiv({ cls: "copilot-empty-avatar" });
      emptyAvatar.createSpan({ text: "✦" });
      empty.createDiv({ text: `${MODE_LABELS[currentMode]} Mode`, cls: "copilot-empty-mode" });
      empty.createDiv({ text: "Ask anything about your notes, code, or ideas...", cls: "copilot-empty-hint" });
    } else {
      for (const msg of state.chatMessages) {
        this.renderMessage(messagesArea, msg.role, msg.content, msg.timestamp);
      }
    }

    // Streaming placeholder
    if (state.chatLoading) {
      const streamWrap = messagesArea.createDiv({ cls: "copilot-msg-wrap copilot-msg-wrap-ai" });
      const avatarRow = streamWrap.createDiv({ cls: "copilot-ai-header" });
      const avatar = avatarRow.createDiv({ cls: "copilot-ai-avatar" });
      avatar.createSpan({ text: "✦" });
      avatarRow.createSpan({ text: "Copilot", cls: "copilot-ai-label" });
      const bodyDiv = streamWrap.createDiv({ cls: "copilot-ai-body copilot-streaming" });
      this.streamingEl = bodyDiv;
    }

    /* --- Footer --- */
    const footer = container.createDiv({ cls: "copilot-footer" });

    // Context bar
    const contextBar = footer.createDiv({ cls: "copilot-context-bar" });
    this.contextBarEl = contextBar;
    this.renderContextBar();

    // Input wrap
    const inputWrap = footer.createDiv({ cls: "copilot-input-wrap" });

    const textarea = inputWrap.createEl("textarea", {
      cls: "copilot-input",
      attr: { placeholder: "Ask Copilot... (/ for menu)", rows: "2" }
    });
    this.inputEl = textarea;

    const inputBottom = inputWrap.createDiv({ cls: "copilot-input-bottom" });
    const inputLeftActions = inputBottom.createDiv({ cls: "copilot-input-left-actions" });

    // Attach button
    const attachBtn = inputLeftActions.createEl("button", { cls: "copilot-input-icon-btn", attr: { title: "Attach a vault file" } });
    setIcon(attachBtn, "paperclip");
    this.attachBadgeEl = attachBtn.createSpan({ cls: "copilot-badge copilot-badge-hidden" });
    attachBtn.addEventListener("click", () => {
      new VaultFileSuggestModal(this.plugin, (file: TFile) => {
        if (!this.attachedFiles.find((f) => f.path === file.path)) {
          this.attachedFiles.push(file);
          this.updateBadges();
          this.renderContextBar();
          new Notice(`Attached: ${file.name}`);
        }
      }).open();
    });

    // Mention button
    const mentionBtn = inputLeftActions.createEl("button", { cls: "copilot-input-icon-btn", attr: { title: "Reference a note (@)" } });
    setIcon(mentionBtn, "at-sign");
    this.refBadgeEl = mentionBtn.createSpan({ cls: "copilot-badge copilot-badge-hidden" });
    mentionBtn.addEventListener("click", () => {
      new VaultNoteSuggestModal(this.plugin, (file: TFile) => {
        if (!this.referencedNotes.find((f) => f.path === file.path)) {
          this.referencedNotes.push(file);
          this.updateBadges();
          this.renderContextBar();
        }
        if (this.inputEl) {
          const ref = `[[${file.basename}]] `;
          const pos = this.inputEl.selectionStart ?? this.inputEl.value.length;
          const before = this.inputEl.value.slice(0, pos);
          const after = this.inputEl.value.slice(pos);
          this.inputEl.value = before + ref + after;
          this.inputEl.focus();
          this.inputEl.selectionStart = this.inputEl.selectionEnd = pos + ref.length;
        }
      }).open();
    });

    // Send / Stop button
    const sendBtn = inputBottom.createEl("button", {
      cls: state.chatLoading ? "copilot-send-btn copilot-stop-btn" : "copilot-send-btn"
    });
    setIcon(sendBtn, state.chatLoading ? "square" : "arrow-up");

    if (state.chatLoading) {
      sendBtn.addEventListener("click", () => this.plugin.stopChat());
    } else {
      sendBtn.addEventListener("click", () => this.submitMessage());
    }

    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!state.chatLoading) this.submitMessage();
      }
    });

    // Info bar: username + sign out on right
    const infoBar = footer.createDiv({ cls: "copilot-info-bar" });

    const rightInfo = infoBar.createDiv({ cls: "copilot-info-right" });
    if (state.username) {
      rightInfo.createSpan({ text: state.username, cls: "copilot-info-text" });
    }
    const signOutBtn = rightInfo.createEl("button", { text: "Sign out", cls: "copilot-signout-btn" });
    signOutBtn.addEventListener("click", async () => { await this.plugin.signOut(); });

    this.scrollToBottom();
  }

  /* ========== History panel ========== */

  private renderHistoryPanel(container: HTMLElement): void {
    const panel = container.createDiv({ cls: "copilot-history-panel" });

    // Header
    const header = panel.createDiv({ cls: "copilot-history-header" });
    header.createSpan({ text: "Chat History", cls: "copilot-history-title" });
    const closeBtn = header.createEl("button", { cls: "copilot-history-close", attr: { title: "Close" } });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => {
      this.showingHistory = false;
      this.render();
    });

    // Session list
    const list = panel.createDiv({ cls: "copilot-history-list" });
    const sessions = this.plugin.getChatSessions();
    const currentId = this.plugin.settings.currentSessionId;

    if (sessions.length === 0) {
      list.createDiv({ text: "No chat history yet", cls: "copilot-history-empty" });
      return;
    }

    for (const session of sessions) {
      const item = list.createDiv({
        cls: `copilot-history-item${session.id === currentId ? " copilot-history-item-active" : ""}`
      });

      const info = item.createDiv({ cls: "copilot-history-item-info" });
      info.createDiv({ text: session.title || "New Chat", cls: "copilot-history-item-title" });

      const msgCount = session.messages.length;
      const timeStr = this.formatSessionDate(session.updatedAt);
      info.createDiv({ text: `${msgCount} messages · ${timeStr}`, cls: "copilot-history-item-meta" });

      // Click to load session
      item.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".copilot-history-item-delete")) return;
        this.showingHistory = false;
        this.plugin.loadSession(session.id);
      });

      // Delete button
      const delBtn = item.createEl("button", { cls: "copilot-history-item-delete", attr: { title: "Delete" } });
      setIcon(delBtn, "trash-2");
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.deleteSession(session.id);
      });
    }
  }

  private formatSessionDate(ts: number): string {
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  /* ========== Helpers ========== */

  private renderMessage(container: HTMLElement, role: "user" | "assistant" | "system", content: string, timestamp?: number): void {
    const isUser = role === "user";

    if (isUser) {
      const wrap = container.createDiv({ cls: "copilot-msg-wrap copilot-msg-wrap-user" });
      const bubble = wrap.createDiv({ cls: "copilot-user-bubble" });
      const bodyDiv = bubble.createDiv({ cls: "copilot-msg-body" });
      MarkdownRenderer.render(this.plugin.app, content, bodyDiv, "", this.plugin);
      if (timestamp) {
        wrap.createDiv({ text: this.formatTimestamp(timestamp), cls: "copilot-msg-time" });
      }
    } else {
      const wrap = container.createDiv({ cls: "copilot-msg-wrap copilot-msg-wrap-ai" });
      const headerRow = wrap.createDiv({ cls: "copilot-ai-header" });
      const avatar = headerRow.createDiv({ cls: "copilot-ai-avatar" });
      avatar.createSpan({ text: "✦" });
      headerRow.createSpan({ text: "Copilot", cls: "copilot-ai-label" });
      const bodyDiv = wrap.createDiv({ cls: "copilot-ai-body" });
      MarkdownRenderer.render(this.plugin.app, content, bodyDiv, "", this.plugin);
    }
  }

  private formatTimestamp(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  private async submitMessage(): Promise<void> {
    const text = this.inputEl?.value.trim();
    if (!text) return;
    if (this.inputEl) this.inputEl.value = "";

    let contextPrefix = "";

    for (const file of this.referencedNotes) {
      try {
        const content = await this.plugin.app.vault.cachedRead(file);
        const truncated = content.slice(0, 8000);
        contextPrefix += `\n\n---\n📄 Note: [[${file.basename}]] (${file.path}):\n${truncated}${content.length > 8000 ? "\n...(truncated)" : ""}\n---\n`;
      } catch { contextPrefix += `\n[Could not read: ${file.path}]\n`; }
    }

    for (const file of this.attachedFiles) {
      const ext = file.extension.toLowerCase();
      const textExts = new Set([
        "md","txt","json","js","ts","css","html","yaml","yml","xml","csv",
        "py","sh","bash","zsh","toml","ini","cfg","jsx","tsx","vue","svelte",
        "rs","go","java","kt","swift","c","cpp","h","hpp","rb","php","sql","r","lua"
      ]);
      if (textExts.has(ext)) {
        try {
          const content = await this.plugin.app.vault.cachedRead(file);
          const truncated = content.slice(0, 8000);
          contextPrefix += `\n\n---\n📎 File: ${file.path}:\n\`\`\`${ext}\n${truncated}${content.length > 8000 ? "\n...(truncated)" : ""}\n\`\`\`\n---\n`;
        } catch { contextPrefix += `\n[Could not read: ${file.path}]\n`; }
      } else {
        contextPrefix += `\n[Attached binary file: ${file.path} (${file.extension})]\n`;
      }
    }

    this.attachedFiles = [];
    this.referencedNotes = [];

    const fullContent = contextPrefix ? `${text}\n\n[Context from attached files/notes]:${contextPrefix}` : text;
    this.plugin.sendChatMessage(fullContent);
  }

  private updateBadges(): void {
    if (this.attachBadgeEl) {
      if (this.attachedFiles.length > 0) {
        this.attachBadgeEl.textContent = String(this.attachedFiles.length);
        this.attachBadgeEl.removeClass("copilot-badge-hidden");
      } else { this.attachBadgeEl.addClass("copilot-badge-hidden"); }
    }
    if (this.refBadgeEl) {
      if (this.referencedNotes.length > 0) {
        this.refBadgeEl.textContent = String(this.referencedNotes.length);
        this.refBadgeEl.removeClass("copilot-badge-hidden");
      } else { this.refBadgeEl.addClass("copilot-badge-hidden"); }
    }
  }

  private renderContextBar(): void {
    if (!this.contextBarEl) return;
    this.contextBarEl.empty();

    const allItems = [
      ...this.attachedFiles.map((f) => ({ type: "attach" as const, file: f })),
      ...this.referencedNotes.map((f) => ({ type: "ref" as const, file: f }))
    ];

    if (allItems.length === 0) {
      this.contextBarEl.addClass("copilot-context-bar-hidden");
      return;
    }
    this.contextBarEl.removeClass("copilot-context-bar-hidden");

    for (const item of allItems) {
      const chip = this.contextBarEl.createDiv({ cls: "copilot-context-chip" });
      const icon = item.type === "attach" ? "📎" : "📄";
      chip.createSpan({ text: `${icon} ${item.file.basename}`, cls: "copilot-context-chip-text" });
      const removeBtn = chip.createSpan({ text: "×", cls: "copilot-context-chip-remove" });
      removeBtn.addEventListener("click", () => {
        if (item.type === "attach") {
          this.attachedFiles = this.attachedFiles.filter((f) => f.path !== item.file.path);
        } else {
          this.referencedNotes = this.referencedNotes.filter((f) => f.path !== item.file.path);
        }
        this.updateBadges();
        this.renderContextBar();
      });
    }
  }

  private scrollToBottom(): void {
    if (!this.messagesContainer) return;
    requestAnimationFrame(() => {
      if (this.messagesContainer) {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
      }
    });
  }
}
