import { beforeEach, describe, expect, it } from "vitest";
import { ApiError, emptyState, isConflictCopy, SyncEngine, type Api, type Change, type LocalFiles, type RemoteNote } from "../src/sync";

/** In-memory stand-in for the server, with the same version rules. */
class FakeServer implements Api {
	notes = new Map<string, RemoteNote & { deleted: boolean; seq: number }>();
	seq = 0;
	private nextId = 1;
	/** This vault's access (the server's per-folder rules), and its fingerprint. */
	canRead = (_path: string) => true;
	canWrite = (_path: string) => true;
	scope: string | undefined = "all";

	live(path: string) {
		return [...this.notes.values()].find((n) => n.path === path && !n.deleted);
	}
	/** A change made by someone else. */
	external(path: string, content: string) {
		const n = this.live(path);
		return n ? this.put(path, content, n.version) : this.put(path, content, null);
	}
	async changes(since: number) {
		const changes: Change[] = [...this.notes.values()]
			.filter((n) => n.seq > since)
			.sort((a, b) => a.seq - b.seq)
			.map((n) =>
				this.canRead(n.path)
					? { id: n.id, path: n.path, version: n.version, seq: n.seq, deleted: n.deleted, content: n.deleted ? undefined : n.content }
					: { id: n.id, path: "", version: n.version, seq: n.seq, deleted: true, hidden: true },
			);
		return { changes, cursor: changes.at(-1)?.seq ?? since, more: false, scope: this.scope };
	}
	async get(path: string) {
		const n = this.live(path);
		if (!n) throw new ApiError(404, "not_found", path);
		return { ...n };
	}
	async put(path: string, content: string, base: number | null) {
		if (!this.canWrite(path)) throw new ApiError(403, "forbidden", path);
		const n = this.live(path);
		if (!n) {
			if (base) throw new ApiError(404, "not_found", path);
			const note = { id: `n${this.nextId++}`, path, content, version: 1, deleted: false, seq: ++this.seq };
			this.notes.set(note.id, note);
			return { ...note };
		}
		if (base === null) throw new ApiError(409, "exists", path);
		if (base !== n.version) throw new ApiError(409, "conflict", path);
		Object.assign(n, { content, version: n.version + 1, seq: ++this.seq });
		return { ...n };
	}
	async move(path: string, newPath: string, base: number) {
		if (!this.canWrite(path) || !this.canWrite(newPath)) throw new ApiError(403, "forbidden", path);
		const n = this.live(path);
		if (!n) throw new ApiError(404, "not_found", path);
		if (base !== n.version) throw new ApiError(409, "conflict", path);
		Object.assign(n, { path: newPath, version: n.version + 1, seq: ++this.seq });
		return { ...n };
	}
	async delete(path: string, base: number) {
		if (!this.canWrite(path)) throw new ApiError(403, "forbidden", path);
		const n = this.live(path);
		if (!n) throw new ApiError(404, "not_found", path);
		if (base !== n.version) throw new ApiError(409, "conflict", path);
		Object.assign(n, { deleted: true, version: n.version + 1, seq: ++this.seq });
		return {};
	}
}

class FakeFiles implements LocalFiles {
	files = new Map<string, string>();
	list() {
		return [...this.files.keys()];
	}
	exists(p: string) {
		return this.files.has(p);
	}
	async read(p: string) {
		const c = this.files.get(p);
		if (c === undefined) throw new Error(`no file ${p}`);
		return c;
	}
	async write(p: string, c: string) {
		this.files.set(p, c);
	}
	async remove(p: string) {
		this.files.delete(p);
	}
	async rename(a: string, b: string) {
		this.files.set(b, await this.read(a));
		this.files.delete(a);
	}
}

let server: FakeServer;
let files: FakeFiles;
let engine: SyncEngine;
let conflicts: string[];
let denied: string[];

beforeEach(async () => {
	server = new FakeServer();
	files = new FakeFiles();
	conflicts = [];
	denied = [];
	engine = new SyncEngine(
		server,
		files,
		emptyState(),
		async () => {},
		{ onConflict: (_p, copy) => conflicts.push(copy), onDenied: (p) => denied.push(p) },
		() => new Date("2026-10-10T12:34:00Z"),
	);
});

describe("SyncEngine", () => {
	it("first sync downloads remote notes and uploads local ones", async () => {
		await server.external("Remote.md", "from server");
		files.files.set("Local.md", "from vault");
		await engine.fullSync();
		expect(files.files.get("Remote.md")).toBe("from server");
		expect(server.live("Local.md")?.content).toBe("from vault");
	});

	it("pushes local edits with the version it last saw, and ignores the echo", async () => {
		await server.external("a.md", "v1");
		await engine.fullSync();
		files.files.set("a.md", "v2 local");
		await engine.fileChanged("a.md");
		expect(server.live("a.md")).toMatchObject({ content: "v2 local", version: 2 });
		files.files.set("a.md", "typed after push"); // must survive the echo of our own change
		await engine.pull();
		expect(files.files.get("a.md")).toBe("typed after push");
	});

	it("applies remote edits to clean files", async () => {
		await server.external("a.md", "v1");
		await engine.fullSync();
		await server.external("a.md", "v2 remote");
		await engine.pull();
		expect(files.files.get("a.md")).toBe("v2 remote");
		expect(conflicts).toEqual([]);
	});

	it("keeps unsynced local edits as a conflict copy when the server moved on", async () => {
		await server.external("a.md", "v1");
		await engine.fullSync();
		files.files.set("a.md", "my edit");
		await server.external("a.md", "their edit");
		await engine.pull();
		expect(files.files.get("a.md")).toBe("their edit");
		expect(conflicts).toEqual(["a (conflict 2026-10-10 1234).md"]);
		expect(files.files.get(conflicts[0])).toBe("my edit");
	});

	it("turns a rejected push into a conflict copy", async () => {
		await server.external("a.md", "v1");
		await engine.fullSync();
		await server.external("a.md", "their edit");
		files.files.set("a.md", "my edit");
		await engine.fileChanged("a.md");
		expect(files.files.get("a.md")).toBe("their edit");
		expect(files.files.get(conflicts[0])).toBe("my edit");
		expect(server.live("a.md")?.content).toBe("their edit");
	});

	it("never syncs conflict copies", async () => {
		files.files.set("a (conflict 2026-10-10 1234).md", "x");
		await engine.fullSync();
		await engine.fileChanged("a (conflict 2026-10-10 1234).md");
		expect(server.notes.size).toBe(0);
		expect(isConflictCopy("x/a (conflict 2026-10-10 1234 2).md")).toBe(true);
	});

	it("moves aside a new local file that collides with a remote note", async () => {
		files.files.set("a.md", "mine");
		await server.external("a.md", "theirs");
		await engine.fileChanged("a.md");
		expect(files.files.get("a.md")).toBe("theirs");
		expect(files.files.get(conflicts[0])).toBe("mine");
	});

	it("follows remote deletes, but keeps a locally edited file", async () => {
		await server.external("clean.md", "c");
		await server.external("dirty.md", "d");
		await engine.fullSync();
		files.files.set("dirty.md", "d + my edit");
		await server.delete("clean.md", 1);
		await server.delete("dirty.md", 1);
		await engine.pull();
		expect(files.exists("clean.md")).toBe(false);
		expect(files.files.get("dirty.md")).toBe("d + my edit");
		await engine.fullSync(); // the kept file comes back as a new note
		expect(server.live("dirty.md")?.content).toBe("d + my edit");
	});

	it("follows remote moves", async () => {
		await server.external("a.md", "A");
		await engine.fullSync();
		await server.move("a.md", "folder/b.md", 1);
		await engine.pull();
		expect(files.exists("a.md")).toBe(false);
		expect(files.files.get("folder/b.md")).toBe("A");
	});

	it("sends local renames and deletes", async () => {
		await server.external("a.md", "A");
		await server.external("gone.md", "G");
		await engine.fullSync();
		await files.rename("a.md", "b.md");
		await engine.fileRenamed("a.md", "b.md");
		expect(server.live("b.md")?.content).toBe("A");
		await files.remove("gone.md");
		await engine.fileDeleted("gone.md");
		expect(server.live("gone.md")).toBeUndefined();
	});

	it("restores files deleted while the plugin was off instead of deleting them remotely", async () => {
		await server.external("a.md", "A");
		await engine.fullSync();
		files.files.delete("a.md");
		await engine.fullSync();
		expect(files.files.get("a.md")).toBe("A");
		expect(server.live("a.md")).toBeDefined();
	});

	it("brings back a note whose delete lost a race with a remote edit", async () => {
		await server.external("a.md", "A");
		await engine.fullSync();
		await server.external("a.md", "A edited");
		await files.remove("a.md");
		await engine.fileDeleted("a.md");
		expect(files.files.get("a.md")).toBe("A edited");
	});

	it("pulls everything again when its access changes, and drops notes that left its reach", async () => {
		await server.external("shared/a.md", "A");
		await server.external("private/b.md", "B");
		server.canRead = (p) => p.startsWith("shared/");
		server.scope = "shared";
		await engine.fullSync();
		expect([...files.files.keys()]).toEqual(["shared/a.md"]);

		server.canRead = () => true;
		server.scope = "all";
		await engine.pull(); // nothing new since the cursor, but the scope changed
		expect(files.files.get("private/b.md")).toBe("B");

		server.canRead = (p) => p.startsWith("shared/");
		server.scope = "shared";
		await engine.pull();
		expect(files.exists("private/b.md")).toBe(false);
		expect(files.files.get("shared/a.md")).toBe("A");
	});

	it("works with an older server that sends no access scope", async () => {
		server.scope = undefined;
		await server.external("a.md", "A");
		await engine.fullSync();
		await server.external("b.md", "B");
		await engine.pull();
		expect(engine.state.scope).toBeUndefined();
		expect(engine.state.cursor).toBe(2);
		expect([...files.files.keys()].sort()).toEqual(["a.md", "b.md"]);
	});

	it("skips files it may not change instead of stopping the sync", async () => {
		server.canWrite = (p) => p.startsWith("mine/");
		files.files.set("theirs/a.md", "x");
		files.files.set("mine/b.md", "y");
		await engine.fullSync();
		expect(denied).toEqual(["theirs/a.md"]);
		expect(server.live("mine/b.md")?.content).toBe("y");
		expect(server.live("theirs/a.md")).toBeUndefined();
	});

	it("puts back a file deleted or renamed where it may not change anything", async () => {
		await server.external("ro/a.md", "A");
		await server.external("ro/b.md", "B");
		server.canWrite = () => false;
		await engine.fullSync();
		await files.remove("ro/a.md");
		await engine.fileDeleted("ro/a.md");
		expect(files.files.get("ro/a.md")).toBe("A");
		await files.rename("ro/b.md", "ro/c.md");
		await engine.fileRenamed("ro/b.md", "ro/c.md");
		expect(files.files.get("ro/b.md")).toBe("B");
		expect(files.exists("ro/c.md")).toBe(false);
		expect(denied).toEqual(["ro/a.md", "ro/b.md"]);
	});
});
