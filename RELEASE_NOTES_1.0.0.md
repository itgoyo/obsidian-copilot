# Obsidian-Copilot 1.0.0

First public release of Obsidian-Copilot.

## Highlights
- GitHub OAuth Device Flow sign-in inside Obsidian.
- Copilot chat in the right sidebar with streaming responses.
- Multiple chat modes: Ask, Agent, Plan.
- Model selector with official API metadata and custom model fallback.
- Chat history support (save, switch, delete sessions).
- Attach files and reference notes to provide richer context.

## Security and privacy
- Uses official GitHub endpoints only.
- No third-party relay API.
- Supports local token persistence and secure desktop encryption when available.

## Known limitations
- Personal Copilot usage and model metadata can be partially unavailable depending on account/API access.
- Built-in OAuth Client ID may hit rate limits under heavy shared usage.
- If needed, configure your own OAuth Client ID in plugin settings.

## Install and update
1. Download release assets: main.js, manifest.json, styles.css.
2. Place them in your vault plugin directory:
   .obsidian/plugins/obsidian-copilot/
3. Reload Obsidian and enable Obsidian-Copilot in Community Plugins.

## Full changelog
- See CHANGELOG.md for detailed change history.
