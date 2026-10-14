# obsidian-shared-kb

Obsidian plugin: two-way sync between a vault folder and a shared-kb server (`..\shared-kb`). Public repo, for anyone who runs a shared-kb server. Read `README.md`.

## Layout

- `src/sync.ts`: the sync engine (pure; no Obsidian imports). All sync rules live here and are tested in `test/sync.test.ts` against an in-memory server.
- `src/tidy.ts`, `src/pairing.ts`: other pure logic, tested.
- `src/main.ts`: Obsidian glue (vault events, settings tab, WebSocket, `VaultFiles`). Keep logic out of it.

## Rules

- **Always backwards compatible, both ways.** Any plugin version must work with any server version, and existing `data.json` files must keep working. New response fields are optional (`scope` may be missing); new `data.json` fields get a default on load; never rename or drop one. One-time fixes for older versions run once, behind a flag in `data.json`, and only touch what an older version could have left behind.
- Never delete a person's files permanently: use `fileManager.trashFile`. Folder tidying is best-effort and never fails a sync.
- TDD: add the failing test first.
- Written for anyone, including non-technical people: plain words in settings and notices, no personal names in code, docs or examples (use "Alex", "kb.example.com").

## Commands

```powershell
npm test; npm run typecheck; npm run build
npm version <x.y.z>; git push --follow-tags   # release: the workflow attaches main.js and manifest.json
```
