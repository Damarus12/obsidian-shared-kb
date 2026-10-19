# obsidian-shared-kb

Obsidian plugin: two-way sync between a vault folder and a shared-kb server (`..\shared-kb`). Public repo, for anyone who runs a shared-kb server. Read `README.md`.

## Layout

- `src/sync.ts`: the sync engine (pure; no Obsidian imports). All sync rules live here and are tested in `test/sync.test.ts` against an in-memory server.
- `src/auth.ts`: sign-in (OAuth + PKCE through the browser, back via obsidian://shared-kb-auth), token refresh, reading settings from before 0.4.0. Pure, tested.
- `src/http-api.ts`: the server's JSON API at `<server>/api/<kb>/` with a bearer token; refreshes once on 401.
- `src/tidy.ts`, `src/pairing.ts`: other pure logic, tested.
- `src/main.ts`: Obsidian glue (vault events, settings tab, WebSocket, `VaultFiles`). Keep logic out of it.

## Rules

- Existing `data.json` files must keep working: new fields get a default on load; old ones are migrated once (the pre-0.4.0 private link becomes server + knowledge base). Since 0.4.0 the plugin needs a server with sign-in; keep the API in step with the server (`../shared-kb`). One-time fixes for older versions run once, behind a flag in `data.json`, and only touch what an older version could have left behind.
- Tokens never go in URLs or notices. Accept an `obsidian://shared-kb-auth` link only for a sign-in this device started (state check).
- Never delete a person's files permanently: use `fileManager.trashFile`. Folder tidying is best-effort and never fails a sync.
- TDD: add the failing test first.
- Written for anyone, including non-technical people: plain words in settings and notices, no personal names in code, docs or examples (use "Alex", "kb.example.com").

## Commands

```powershell
npm test; npm run typecheck; npm run build
npm version <x.y.z>; git push --follow-tags   # release: the workflow attaches main.js and manifest.json
```
