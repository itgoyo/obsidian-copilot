# Changelog

All notable changes to this project are documented in this file.

## 1.0.0 - 2026-04-03

### Added
- Initial release of Obsidian-Copilot community plugin.
- Right-sidebar Copilot chat panel for Obsidian.
- GitHub OAuth Device Flow sign-in inside Obsidian.
- Model selector with official endpoint support and custom fallback models.
- Chat modes: Ask, Agent, Plan.
- Chat history management: create, load, and delete sessions.
- Attach vault files and reference notes as chat context.
- Streaming assistant response rendering in the sidebar.
- Usage/model metadata fetch with graceful unavailable fallback.
- Settings for OAuth, endpoints, model behavior, and token persistence.
- Local token storage with desktop secure storage support when available.

### Security
- Official GitHub endpoints only.
- HTTPS + allowed-host validation for configurable endpoints.
- Optional encrypted token persistence in desktop environment.

### Notes
- Some Copilot usage/model details may be unavailable for certain accounts due to official API limitations.
- Built-in OAuth app can be rate-limited; users can provide their own OAuth Client ID in settings.
