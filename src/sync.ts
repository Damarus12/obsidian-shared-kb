/**
 * Two-way sync between a folder of Markdown files and a shared-kb server.
 * No Obsidian imports here, so it runs under plain Vitest with fakes.
 *
 * Rules:
 * - The server is the source of truth. Every push carries the version this
 *   vault last saw; the server rejects it if someone changed the note since.
 * - Local edits are never thrown away. If a pull meets an unsynced local
 *   edit, the local text is saved next to the note as a "(conflict …)" copy,
 *   which is not synced, and the server's text takes the original path.
 * - State is updated *before* touching files, so the file events our own
 *   writes trigger are recognized as already in sync and ignored.
 * - The server may give this vault access to some folders only. Notes outside
 *   it arrive as `hidden` deletes; when the access changes (a new `scope`), the
 *   whole feed is pulled again. Changes the server refuses (403) are skipped,
 *   and a refused delete or rename is undone locally.
 */

export interface RemoteNote {
	id: string;
	path: string;
	version: number;
	content: string;
}

export interface Change {
	id: string;
	path: string;
	version: number;
	seq: number;
	deleted: boolean;
	content?: string;
	/** Outside this vault's access: drop the local copy. */
	hidden?: boolean;
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export interface Api {
	/** `scope` (newer servers) changes whenever this link's access does. */
	changes(since: number): Promise<{ changes: Change[]; cursor: number; more: boolean; scope?: string }>;
	get(path: string): Promise<RemoteNote>;
	put(path: string, content: string, baseVersion: number | null): Promise<RemoteNote>;
	move(path: string, newPath: string, baseVersion: number): Promise<RemoteNote>;
	delete(path: string, baseVersion: number): Promise<unknown>;
}

/** Files in server path space (the sync folder prefix is the adapter's job). */
export interface LocalFiles {
	list(): string[];
	exists(path: string): boolean;
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

export interface SyncState {
	cursor: number;
	/** The server's `scope` at the last pull. */
	scope?: string;
	/** By note id: where it lives locally, the version we have, and a hash of its synced text. */
	notes: Record<string, { path: string; version: number; hash: string }>;
}

export const emptyState = (): SyncState => ({ cursor: 0, notes: {} });

const CONFLICT = / \(conflict [^)]*\)\.md$/i;

export function isConflictCopy(path: string): boolean {
	return CONFLICT.test(path);
}

export function conflictPath(path: string, now: Date, exists: (p: string) => boolean): string {
	const stamp = now.toISOString().slice(0, 16).replace("T", " ").replace(":", "");
	const stem = path.replace(/\.md$/i, "");
	let candidate = `${stem} (conflict ${stamp}).md`;
	for (let i = 2; exists(candidate); i++) candidate = `${stem} (conflict ${stamp} ${i}).md`;
	return candidate;
}

/** cyrb53: fast, good-enough change detection (not security). */
export function hash(s: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface SyncEvents {
	onConflict?(path: string, copy: string): void;
	/** The server refused a change to `path` (no write access there). */
	onDenied?(path: string): void;
	onError?(error: unknown): void;
}

export class SyncEngine {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly api: Api,
		private readonly files: LocalFiles,
		readonly state: SyncState,
		private readonly save: (state: SyncState) => Promise<void>,
		private readonly events: SyncEvents = {},
		private readonly now: () => Date = () => new Date(),
	) {}

	// ---- public operations (serialized) ----------------------------------

	/** Pull everything new, then push local files that are new or edited. */
	fullSync(): Promise<void> {
		return this.serial(async () => {
			await this.pullNow();
			for (const path of this.files.list()) {
				if (!isConflictCopy(path)) await this.pushNow(path);
			}
			// Files deleted while the plugin was off are restored, never deleted remotely.
			for (const [id, entry] of Object.entries(this.state.notes)) {
				if (!this.files.exists(entry.path)) await this.restore(id, entry.path);
			}
			await this.save(this.state);
		});
	}

	pull(): Promise<void> {
		return this.serial(async () => {
			await this.pullNow();
			await this.save(this.state);
		});
	}

	fileChanged(path: string): Promise<void> {
		return this.serial(async () => {
			if (isConflictCopy(path) || !this.files.exists(path)) return;
			await this.pushNow(path);
			await this.save(this.state);
		});
	}

	fileDeleted(path: string): Promise<void> {
		return this.serial(async () => {
			const found = this.byPath(path);
			if (!found) return;
			const [id, entry] = found;
			try {
				await this.api.delete(path, entry.version);
				delete this.state.notes[id];
			} catch (e) {
				if (status(e) === 404) delete this.state.notes[id];
				else if (status(e) === 409) await this.pullNow(); // changed remotely: the pull brings it back
				else if (status(e) === 403) {
					this.events.onDenied?.(path);
					await this.restore(id, path);
				} else throw e;
			}
			await this.save(this.state);
		});
	}

	fileRenamed(from: string, to: string): Promise<void> {
		return this.serial(async () => {
			const found = this.byPath(from);
			if (!found) {
				if (!isConflictCopy(to) && this.files.exists(to)) await this.pushNow(to);
			} else {
				const [, entry] = found;
				try {
					const moved = await this.api.move(from, to, entry.version);
					entry.path = moved.path;
					entry.version = moved.version;
				} catch (e) {
					if (status(e) === 409) await this.pullNow();
					else if (status(e) === 403) {
						this.events.onDenied?.(from);
						if (this.files.exists(to) && !this.files.exists(from)) await this.files.rename(to, from);
					} else throw e;
				}
			}
			await this.save(this.state);
		});
	}

	// ---- internals -------------------------------------------------------

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch((e) => this.events.onError?.(e));
		return run;
	}

	private byPath(path: string): [string, SyncState["notes"][string]] | undefined {
		return Object.entries(this.state.notes).find(([, e]) => e.path === path);
	}

	private async pullNow(): Promise<void> {
		for (;;) {
			const page = await this.api.changes(this.state.cursor);
			if (page.scope !== undefined && page.scope !== this.state.scope) {
				// Access changed: notes shared with us earlier than the cursor must come down too.
				this.state.scope = page.scope;
				if (this.state.cursor !== 0) {
					this.state.cursor = 0;
					continue;
				}
			}
			for (const change of page.changes) await this.apply(change);
			this.state.cursor = page.cursor;
			if (!page.more) return;
		}
	}

	private async apply(change: Change): Promise<void> {
		const entry = this.state.notes[change.id];
		// A note can leave our reach without changing version, so deletes skip the echo check
		// (the feed only ever sends a note's latest state, so a delete is never stale).
		if (!change.deleted && entry && entry.version >= change.version) return; // our own write echoing back

		if (change.deleted) {
			if (!entry) return;
			delete this.state.notes[change.id];
			if (this.files.exists(entry.path)) {
				const local = await this.files.read(entry.path);
				// Unsynced local edits keep the file; the next push re-creates the note.
				if (hash(local) === entry.hash) await this.files.remove(entry.path);
			}
			return;
		}

		const content = change.content ?? "";
		const target = change.path;
		let current = entry?.path;

		// The note moved remotely: follow it, unless that path is taken by an unrelated local file.
		if (entry && current !== target && current && this.files.exists(current)) {
			await this.moveAside(target, change.id);
			entry.path = target;
			await this.files.rename(current, target);
			current = target;
		}
		if (!entry) await this.moveAside(target, change.id);

		const localExists = this.files.exists(target);
		const local = localExists ? await this.files.read(target) : null;
		const dirty = entry !== undefined && local !== null && local !== content && hash(local) !== entry.hash;

		this.state.notes[change.id] = { path: target, version: change.version, hash: hash(content) };
		if (dirty) {
			const copy = conflictPath(target, this.now(), (p) => this.files.exists(p));
			await this.files.write(copy, local!);
			this.events.onConflict?.(target, copy);
		}
		if (local !== content) await this.files.write(target, content);
	}

	/** If an unmapped local file sits where a remote note must go, keep it as a conflict copy. */
	private async moveAside(path: string, incomingId: string): Promise<void> {
		if (!this.files.exists(path)) return;
		const owner = this.byPath(path);
		if (owner && owner[0] === incomingId) return;
		if (owner) {
			// Another synced note claims this path; the feed will move or delete it next.
			delete this.state.notes[owner[0]];
		}
		const copy = conflictPath(path, this.now(), (p) => this.files.exists(p));
		await this.files.rename(path, copy);
		this.events.onConflict?.(path, copy);
	}

	private async pushNow(path: string): Promise<void> {
		const content = await this.files.read(path);
		const found = this.byPath(path);
		if (found && hash(content) === found[1].hash) return;
		try {
			const saved = await this.api.put(path, content, found ? found[1].version : null);
			this.state.notes[saved.id] = { path: saved.path, version: saved.version, hash: hash(content) };
		} catch (e) {
			// Someone else changed or created this note: pull, which turns our text into a conflict copy.
			if (status(e) === 409) await this.pullNow();
			// No write access there: leave the file alone and keep syncing the rest.
			else if (status(e) === 403) this.events.onDenied?.(path);
			else throw e;
		}
	}

	private async restore(id: string, path: string): Promise<void> {
		try {
			const note = await this.api.get(path);
			this.state.notes[note.id] = { path: note.path, version: note.version, hash: hash(note.content) };
			if (note.id !== id) delete this.state.notes[id];
			await this.files.write(note.path, note.content);
		} catch (e) {
			if (status(e) === 404) delete this.state.notes[id];
			else throw e;
		}
	}
}

function status(e: unknown): number | undefined {
	return e instanceof ApiError ? e.status : undefined;
}
