# Obsidian-Copilot

A community plugin that adds GitHub Copilot chat and model selection to the Obsidian right sidebar.

## Features

- Official GitHub OAuth Device Flow login UX inside Obsidian.
- Right-sidebar panel for quick access.
- Model metadata list and multiplier display when available from official endpoint metadata.
- Usage panel with explicit unavailable fallback when official personal usage API is not exposed.
- Local token storage in plugin data for the current vault.
- Optional session-only token mode (default) to reduce token-at-rest risk.

## Important Compliance Notes

- This plugin only calls official GitHub endpoints.
- No third-party relay APIs are used.
- Some personal Copilot model/usage capabilities may not be exposed through public official APIs. In that case the plugin shows clear unavailable messages.

## Setup

1. Open the right sidebar panel and click Sign in.
2. Browser opens GitHub device login.
3. Copy the shown code from Obsidian and paste at https://github.com/login/device.
4. Complete authorization and return to Obsidian.

Optional advanced setup: set your own OAuth Client ID in plugin settings to override the built-in OAuth App.

## Development

Install dependencies:

npm install

Build plugin:

npm run build

Dev watch:

npm run dev

## Community Plugin Submission Checklist

- Ensure manifest fields are complete: id, name, author, description, minAppVersion.
- Publish source code and release artifacts to GitHub.
- Provide README, LICENSE, and CHANGELOG.
- Tag releases and update versions.json on every release.
- Submit a PR to the Obsidian community plugin list so users can search and install it in Community Plugins.

## Security

- Keep OAuth scopes minimal.
- Never commit Client Secret.
- Device flow always requires a Client ID (built-in by default in this plugin, or custom override).
- Endpoint settings are restricted to official GitHub hosts over HTTPS.

## Limitations

- Built-in OAuth App is shared by plugin users and may hit GitHub rate limits.
- If built-in OAuth login is unavailable, set your own OAuth Client ID in plugin settings.
