# Shared KB for Obsidian

Two-way sync between an Obsidian vault folder and a **shared-kb** knowledge base: Markdown notes that several people and their AI assistants (Claude, ChatGPT, Claude Code, any MCP client) read and edit together.

Edit a note in Obsidian and everyone else sees it within seconds. When someone (or their AI) changes a note, it updates in your vault live.

> **You need a shared-kb server and a member link.** The plugin does nothing on its own. The server isn't published yet; if someone invited you, they gave you a link.

## Install

**With BRAT (desktop and iPhone/iPad/Android, gets updates automatically)**

1. Settings → Community plugins → turn on community plugins → Browse → install and enable **BRAT**.
2. Settings → BRAT → **Add beta plugin** → paste `https://github.com/Damarus12/obsidian-shared-kb` → **Add plugin**.
3. Settings → Community plugins → enable **Shared KB**.

**By hand (desktop):** download `main.js` and `manifest.json` from the [latest release](https://github.com/Damarus12/obsidian-shared-kb/releases/latest) into `<vault>/.obsidian/plugins/shared-kb/`, then enable **Shared KB** under Community plugins.

## Set up

Settings → Shared KB:

- **Member link:** paste your link (ending in `/` or `/mcp`).
- **Folder:** the vault folder to sync into, or empty for the whole vault. A new, empty vault is simplest.
- **Connect & sync.** The status bar shows `KB: synced`.

Commands: **Sync now**, **Open knowledge base in browser**.

## How it syncs

- The server is the source of truth. Every note has a version; the plugin sends the version it last saw with each change, so it never overwrites an edit it hasn't seen.
- **Conflicts:** if a note changed on the server while you had unsynced edits, the server's version takes the file and yours is saved beside it as `Name (conflict 2026-10-10 1234).md`. Conflict copies aren't synced. Merge by hand, then delete the copy.
- Files deleted while Obsidian was closed are restored from the server, not deleted for everyone. Deleting a note while Obsidian is open deletes it for everyone (the server keeps its history, so it can be restored).
- Only `.md` files sync. Hidden folders (starting with `.`) are skipped. Images and attachments aren't supported yet.
- Live updates over a WebSocket, plus a check every 5 minutes and whenever the app comes back to the foreground.

## Network use and privacy

- The plugin talks **only to the server in your member link**: HTTPS for notes and a WebSocket for change notifications. No telemetry, no other services.
- Notes in the synced folder are sent to that server and stored there.
- Your member link is a credential (anyone with it has your access). It's stored in this plugin's `data.json` inside your vault's `.obsidian` folder, so don't share that file or commit it to a public repo.

## Develop

```
npm install
npm test            # unit tests
npm run typecheck
npm run build       # → dist/main.js
```

`test/integration.test.ts` runs two simulated vaults against a real server; it's skipped unless `KB_TEST_LINK` is set to a member link.

**Release:** `npm version <x.y.z>` (updates `manifest.json` and `versions.json`), then `git push --follow-tags`. The Release workflow builds and attaches `main.js` and `manifest.json`.

## License

MIT
