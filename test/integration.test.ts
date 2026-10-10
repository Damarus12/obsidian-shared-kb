// Runs two "vaults" (temp folders) against a real server.
// Skipped unless KB_TEST_LINK is set to a member link, e.g. from `wrangler dev`:
//   $env:KB_TEST_LINK = "http://127.0.0.1:8787/kb/<kb>/<token>/"; npx vitest run test/integration.test.ts
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HttpApi, type Requester } from "../src/http-api";
import { emptyState, SyncEngine, type LocalFiles } from "../src/sync";

const link = process.env.KB_TEST_LINK;
const run = Math.random().toString(36).slice(2, 8);
const dirs: string[] = [];

const fetchRequest: Requester = async ({ url, method, body }) => {
	const res = await fetch(url, { method, body, headers: { "Content-Type": "application/json" } });
	return { status: res.status, json: await res.json().catch(() => null) };
};

/** A vault folder that only sees `it-<run>/` so tests don't touch other notes. */
class DiskFiles implements LocalFiles {
	constructor(readonly root: string) {}
	private abs(p: string) {
		return join(this.root, ...p.split("/"));
	}
	list(): string[] {
		const out: string[] = [];
		const walk = (d: string) => {
			for (const name of readdirSync(d)) {
				const full = join(d, name);
				if (statSync(full).isDirectory()) walk(full);
				else if (name.endsWith(".md")) out.push(relative(this.root, full).split("\\").join("/"));
			}
		};
		walk(this.root);
		return out.filter((p) => p.startsWith(`it-${run}/`));
	}
	exists(p: string) {
		return existsSync(this.abs(p));
	}
	read(p: string) {
		return readFile(this.abs(p), "utf8");
	}
	async write(p: string, c: string) {
		await mkdir(dirname(this.abs(p)), { recursive: true });
		await writeFile(this.abs(p), c);
	}
	remove(p: string) {
		return rm(this.abs(p));
	}
	async rename(a: string, b: string) {
		await mkdir(dirname(this.abs(b)), { recursive: true });
		await rename(this.abs(a), this.abs(b));
	}
}

async function vault() {
	const root = await mkdtemp(join(tmpdir(), "kb-vault-"));
	dirs.push(root);
	const files = new DiskFiles(root);
	const engine = new SyncEngine(new HttpApi(link!, fetchRequest), files, emptyState(), async () => {});
	return { files, engine };
}

afterAll(async () => {
	for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe.skipIf(!link)("two vaults through a real server", () => {
	const p = (name: string) => `it-${run}/${name}`;

	it("syncs creates, edits, moves, deletes and conflicts", async () => {
		const a = await vault();
		const b = await vault();

		await a.files.write(p("Idea.md"), "---\nstatus: idea\n---\nA mill.");
		await a.engine.fullSync();
		await b.engine.fullSync();
		expect(await b.files.read(p("Idea.md"))).toContain("A mill.");

		await b.files.write(p("Idea.md"), "---\nstatus: idea\n---\nA windmill.");
		await b.engine.fileChanged(p("Idea.md"));
		await a.engine.pull();
		expect(await a.files.read(p("Idea.md"))).toContain("A windmill.");

		// Both edit; b pushes first, so a's edit becomes a conflict copy.
		await a.files.write(p("Idea.md"), "a's edit");
		await b.files.write(p("Idea.md"), "b's edit");
		await b.engine.fileChanged(p("Idea.md"));
		await a.engine.fileChanged(p("Idea.md"));
		expect(await a.files.read(p("Idea.md"))).toBe("b's edit");
		const copy = a.files.list().find((x) => x.includes("(conflict"));
		expect(copy && (await a.files.read(copy))).toBe("a's edit");

		await a.files.rename(p("Idea.md"), p("Done/Idea.md"));
		await a.engine.fileRenamed(p("Idea.md"), p("Done/Idea.md"));
		await b.engine.pull();
		expect(b.files.exists(p("Idea.md"))).toBe(false);
		expect(await b.files.read(p("Done/Idea.md"))).toBe("b's edit");

		await b.files.remove(p("Done/Idea.md"));
		await b.engine.fileDeleted(p("Done/Idea.md"));
		await a.engine.pull();
		expect(a.files.exists(p("Done/Idea.md"))).toBe(false);
	});
});
