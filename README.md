# Shared KB for Obsidian

Two-way sync between an Obsidian vault folder and a **shared-kb** knowledge base: Markdown notes that several people and their AI assistants (Claude, ChatGPT, Claude Code, any MCP client) read and edit together.

Edit a note in Obsidian and everyone else sees it within seconds. When someone (or their AI) changes a note, it updates in your vault live.

> **You need an account on a shared-kb server.** The plugin does nothing on its own. If someone invited you, open their invite link first and make a passkey; then sign in from the plugin.

## Install

**With BRAT (desktop and iPhone/iPad/Android, gets updates automatically)**

1. Settings → Community plugins → turn on community plugins → Browse → install and enable **BRAT**.
2. Settings → BRAT → **Add beta plugin** → paste `https://github.com/Damarus12/obsidian-shared-kb` → **Add plugin**.
3. Settings → Community plugins → enable **Shared KB**.

**By hand (desktop):** download `main.js` and `manifest.json` from the [latest release](https://github.com/Damarus12/obsidian-shared-kb/releases/latest) into `<vault>/.obsidian/plugins/shared-kb/`, then enable **Shared KB** under Community plugins.

## Set up

Settings → Shared KB:

1. **Server:** your knowledge base's address, e.g. `kb.example.com`.
2. **Sign in:** your browser opens. Sign in with your passkey, tap **Allow**, then **Open Obsidian**. (New here? Open the invite link you were sent first, to make your passkey.)
3. **Knowledge base:** if your account is in more than one, choose which one this vault syncs with.
4. **Folder:** the vault folder to sync into, or empty for the whole vault. A new, empty vault is simplest.
5. **Connect & sync.** On desktop the status bar shows `KB: synced`.

Commands: **Sync now**, **Open knowledge base in browser**.

Upgrading from a version before 0.4.0: the private link is gone. The plugin keeps the server and knowledge base from it (and what's already synced); tap **Sign in** once.

## How it syncs

- The server is the source of truth. Every note has a version; the plugin sends the version it last saw with each change, so it never overwrites an edit it hasn't seen.
- **Conflicts:** if a note changed on the server while you had unsynced edits, the server's version takes the file and yours is saved beside it as `Name (conflict 2026-10-10 1234).md`. Conflict copies aren't synced. Merge by hand, then delete the copy.
- Files deleted while Obsidian was closed are restored from the server, not deleted for everyone. Deleting a note while Obsidian is open deletes it for everyone (the server keeps its history, so it can be restored).
- When a note moves or is deleted, folders it leaves empty are removed (to the trash). Versions before 0.3.1 could leave them behind on Windows; 0.3.2 removes those once, after its first sync, in vaults that had synced before.
- Only `.md` files sync. Hidden folders (starting with `.`) are skipped. Images and attachments aren't supported yet.
- Live updates over a WebSocket, plus a check every 5 minutes and whenever the app comes back to the foreground.

## Network use and privacy

- The plugin talks **only to the server address you entered**: HTTPS for notes, sign-in and tokens, and a WebSocket for change notifications. No telemetry, no other services.
- Signing in happens in your browser (passkey, then **Allow**). The server sends a one-time code back through an `obsidian://shared-kb-auth` link; the plugin only accepts it for a sign-in it started, and only it can use it (PKCE).
- Notes in the synced folder are sent to that server and stored there.
- The plugin stores its sign-in (an hour-long access token and a refresh token) in its `data.json` inside your vault's `.obsidian` folder. Anyone with that file can sync as you until you disconnect the app on your account page, so don't share it or commit it to a public repo.

## Compatibility

0.4.0 needs a server with sign-in (passkeys and OAuth). Older plugin versions only work with older servers.

## Develop

```
npm install
npm test            # unit tests
npm run typecheck
npm run build       # → dist/main.js
```

`test/integration.test.ts` runs two simulated vaults against a real server; it's skipped unless `KB_TEST_KB` (a knowledge base address) and `KB_TOKEN` (from the server's `scripts/token.mjs`) are set.

**Release:** `npm version <x.y.z>` (updates `manifest.json` and `versions.json`), then `git push --follow-tags`. The Release workflow builds and attaches `main.js` and `manifest.json`.

## License

MIT
