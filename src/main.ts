import { App, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import { HttpApi, type Requester } from "./http-api";
import { deviceLabel, memberLinkFrom, normalizeServer, pairDevice, sameKnowledgeBase } from "./pairing";
import { ApiError, emptyState, SyncEngine, type LocalFiles, type SyncState } from "./sync";

interface Settings {
	/** This device's member link, e.g. https://kb.example.com/kb/abc/token/ */
	link: string;
	/** Vault folder that mirrors the knowledge base ("" = whole vault). */
	folder: string;
	/** Who this link belongs to, e.g. "Sean · Obsidian (iPhone)" (display only). */
	who: string;
}

interface Data {
	settings: Settings;
	state: SyncState;
	/** The link the state belongs to; a different link starts a fresh sync. */
	stateLink?: string;
}

const DEFAULTS: Settings = { link: "", folder: "", who: "" };

/** requestUrl skips CORS and works on mobile; errors come back as status codes. */
const obsidianRequest: Requester = async ({ url, method, body }) => {
	const res = await requestUrl({ url, method, body, contentType: "application/json", throw: false });
	let json: unknown = null;
	try {
		json = res.json;
	} catch {
		// not JSON
	}
	return { status: res.status, json };
};
const PUSH_DELAY_MS = 1500;
const POLL_MS = 5 * 60 * 1000;

export default class SharedKbPlugin extends Plugin {
	data: Data = { settings: { ...DEFAULTS }, state: emptyState() };
	private engine: SyncEngine | null = null;
	private socket: WebSocket | null = null;
	private retry = 0;
	private retryTimer: number | null = null;
	private pending = new Map<string, number>();
	private statusEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		const saved = (await this.loadData()) as Partial<Data> | null;
		this.data = {
			settings: { ...DEFAULTS, ...saved?.settings },
			state: saved?.state ?? emptyState(),
			stateLink: saved?.stateLink,
		};
		this.statusEl = this.addStatusBarItem();
		this.addSettingTab(new SettingsTab(this.app, this));
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
		this.addCommand({
			id: "open-in-browser",
			name: "Open knowledge base in browser",
			callback: () => this.data.settings.link && window.open(this.base()),
		});
		// "Open in Obsidian" on the server's pairing page: obsidian://shared-kb?link=<this device's link>
		this.registerObsidianProtocolHandler("shared-kb", (params) => this.offerLink(params.link ?? ""));
		this.app.workspace.onLayoutReady(() => {
			this.registerVaultEvents();
			void this.start();
		});
		this.registerInterval(window.setInterval(() => this.track(this.engine?.pull()), POLL_MS));
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible") this.track(this.engine?.pull());
		});
	}

	onunload(): void {
		this.stop();
	}

	/** (Re)connects with the current settings. */
	async start(): Promise<void> {
		this.stop();
		const { link } = this.data.settings;
		if (!link) return this.status("not set up");
		if (this.data.stateLink !== link) {
			// A new link for the same knowledge base (e.g. this device's own) keeps what's already synced.
			if (!sameKnowledgeBase(this.data.stateLink, link)) this.data.state = emptyState();
			this.data.stateLink = link;
		}
		this.engine = new SyncEngine(new HttpApi(this.base(), obsidianRequest), new VaultFiles(this.app, this.data.settings.folder), this.data.state, () => this.saveData(this.data), {
			onConflict: (path, copy) => new Notice(`Shared KB: "${path}" changed on the server while you edited it. Your version is in "${copy}".`, 15000),
			onError: (e) => this.fail(e),
		});
		await this.syncNow();
		this.connect();
		if (!this.data.settings.who) await this.lookupWho();
	}

	/** Fills in who this link belongs to, for the settings tab. */
	private async lookupWho(): Promise<void> {
		try {
			const res = await obsidianRequest({ url: `${this.base()}api/me`, method: "GET" });
			const me = res.json as { name?: string; device?: string; role?: string } | null;
			if (res.status !== 200 || !me?.name) return;
			this.data.settings.who = `${me.name}${me.device ? ` · ${me.device}` : ""}${me.role === "read" ? " (read-only)" : ""}`;
			await this.saveData(this.data);
		} catch {
			// Offline; try again next start.
		}
	}

	async syncNow(): Promise<void> {
		if (!this.engine) return;
		this.status("syncing…");
		try {
			await this.engine.fullSync();
			this.status("synced");
		} catch (e) {
			this.fail(e, true);
		}
	}

	base(): string {
		return this.data.settings.link.trim().replace(/\/(mcp)?\/?$/, "") + "/";
	}

	/** Trades a one-time code from the server's Devices page for this device's own link, then syncs. */
	async pair(server: string, code: string): Promise<void> {
		const paired = await pairDevice(obsidianRequest, server, code, deviceLabel(Platform));
		await this.useLink(paired.link, `${paired.name}${paired.device ? ` · ${paired.device}` : ""}${paired.role === "read" ? " (read-only)" : ""}`);
		new Notice(`Shared KB: connected as ${this.data.settings.who}.`);
	}

	async useLink(link: string, who: string): Promise<void> {
		this.data.settings.link = link;
		this.data.settings.who = who;
		await this.saveData(this.data);
		await this.start();
	}

	/** A link that arrived by obsidian:// URL. Any web page can open one, so the person confirms first. */
	private offerLink(raw: string): void {
		const link = memberLinkFrom(raw);
		if (!link) {
			new Notice("Shared KB: that wasn't a valid link.");
			return;
		}
		const { folder } = this.data.settings;
		new ConfirmModal(
			this.app,
			"Connect to a knowledge base?",
			`Notes in ${folder ? `the "${folder}" folder` : "this whole vault"} will sync with ${new URL(link).host}. Only continue if you just tapped "Open in Obsidian" on your own device.`,
			"Connect",
			() => void this.useLink(link, "").then(() => new Notice(`Shared KB: connected to ${new URL(link).host}.`)),
		).open();
	}

	private stop(): void {
		if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.socket?.close();
		this.socket = null;
		for (const t of this.pending.values()) window.clearTimeout(t);
		this.pending.clear();
		this.engine = null;
	}

	/** Live updates: the server sends {type:"changed"} after every write. */
	private connect(): void {
		const engine = this.engine;
		if (!engine) return;
		const ws = new WebSocket(this.base().replace(/^http/, "ws") + "ws");
		this.socket = ws;
		let ping: number | null = null;
		ws.onopen = () => {
			this.retry = 0;
			ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30000);
		};
		ws.onmessage = (e) => {
			let msg: { type?: string; seq?: number };
			try {
				msg = JSON.parse(String(e.data)) as typeof msg;
			} catch {
				return; // "pong", or anything else that isn't an event
			}
			if ((msg.type === "changed" || msg.type === "hello") && (msg.seq ?? 0) > engine.state.cursor) {
				this.track(engine.pull());
			}
		};
		ws.onclose = () => {
			if (ping !== null) window.clearInterval(ping);
			if (this.socket !== ws || this.engine !== engine) return; // replaced or stopped
			this.status("offline, retrying");
			const delay = Math.min(60000, 1000 * 2 ** this.retry++);
			this.retryTimer = window.setTimeout(() => this.connect(), delay);
		};
	}

	private registerVaultEvents(): void {
		const local = (path: string) => VaultFiles.toRemote(path, this.data.settings.folder);
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				const p = f instanceof TFile ? local(f.path) : null;
				if (p) this.schedulePush(p);
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (f) => {
				const p = f instanceof TFile ? local(f.path) : null;
				if (p) this.schedulePush(p);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				const p = f instanceof TFile ? local(f.path) : null;
				if (p) this.track(this.engine?.fileDeleted(p));
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (!(f instanceof TFile)) return;
				const from = local(oldPath);
				const to = local(f.path);
				if (from && to) this.track(this.engine?.fileRenamed(from, to));
				else if (from) this.track(this.engine?.fileDeleted(from)); // moved out of the synced folder
				else if (to) this.schedulePush(to); // moved in
			}),
		);
	}

	/** Typing fires many modify events; push once the file has been quiet for a moment. */
	private schedulePush(path: string): void {
		const existing = this.pending.get(path);
		if (existing !== undefined) window.clearTimeout(existing);
		this.pending.set(
			path,
			window.setTimeout(() => {
				this.pending.delete(path);
				this.track(this.engine?.fileChanged(path));
			}, PUSH_DELAY_MS),
		);
	}

	/** Errors are already reported through the engine's onError. */
	private track(p: Promise<void> | undefined): void {
		p?.then(
			() => this.status("synced"),
			() => {},
		);
	}

	private status(text: string): void {
		this.statusEl?.setText(`KB: ${text}`);
	}

	/** Background errors only show in the status bar; a failed full sync (startup, "Sync now") also gets a notice. */
	private fail(e: unknown, notify = false): void {
		console.error("Shared KB", e);
		this.status("error");
		if (!notify) return;
		const badLink = e instanceof ApiError && [401, 403, 404].includes(e.status);
		const msg = badLink
			? "This link isn't valid (it may be incomplete, or was revoked). Copy it again, or ask for a new one."
			: `Sync failed: ${e instanceof Error ? e.message : String(e)}`;
		new Notice(`Shared KB: ${msg}`, 15000);
	}
}

/** Maps server paths onto a vault folder. */
class VaultFiles implements LocalFiles {
	constructor(
		private readonly app: App,
		private readonly folder: string,
	) {}

	/** Vault path → server path, or null if outside the synced folder or not Markdown. */
	static toRemote(vaultPath: string, folder: string): string | null {
		if (!vaultPath.toLowerCase().endsWith(".md")) return null;
		const prefix = folder ? normalizePath(folder) + "/" : "";
		if (prefix && !vaultPath.startsWith(prefix)) return null;
		const p = vaultPath.slice(prefix.length);
		return p.split("/").some((s) => s.startsWith(".")) ? null : p;
	}

	private local(p: string): string {
		return normalizePath(this.folder ? `${this.folder}/${p}` : p);
	}

	private file(p: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.local(p));
		return f instanceof TFile ? f : null;
	}

	list(): string[] {
		return this.app.vault
			.getMarkdownFiles()
			.map((f) => VaultFiles.toRemote(f.path, this.folder))
			.filter((p): p is string => p !== null);
	}
	exists(p: string): boolean {
		return this.file(p) !== null;
	}
	async read(p: string): Promise<string> {
		const f = this.file(p);
		if (!f) throw new Error(`Missing file ${p}`);
		return this.app.vault.read(f);
	}
	async write(p: string, content: string): Promise<void> {
		const f = this.file(p);
		if (f) return this.app.vault.modify(f, content);
		await this.ensureFolder(this.local(p));
		await this.app.vault.create(this.local(p), content);
	}
	async remove(p: string): Promise<void> {
		const f = this.file(p);
		if (!f) return;
		await this.app.fileManager.trashFile(f);
		await this.pruneEmpty(this.local(p));
	}
	async rename(from: string, to: string): Promise<void> {
		const f = this.file(from);
		if (!f) return;
		await this.ensureFolder(this.local(to));
		// vault.rename, not fileManager.renameFile: rewriting links in other notes would push edits nobody made.
		await this.app.vault.rename(f, this.local(to));
		await this.pruneEmpty(this.local(from));
	}

	/** After a sync removes or moves a file away, delete folders it left empty (never the sync folder itself). */
	private async pruneEmpty(filePath: string): Promise<void> {
		const root = this.folder ? normalizePath(this.folder) : "";
		let dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
		while (dir && dir !== root) {
			const folder = this.app.vault.getAbstractFileByPath(dir);
			if (!(folder instanceof TFolder) || folder.children.length > 0) return;
			await this.app.vault.delete(folder);
			dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
		}
	}

	private async ensureFolder(filePath: string): Promise<void> {
		const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
		if (!dir || this.app.vault.getAbstractFileByPath(dir) instanceof TFolder) return;
		let current = "";
		for (const part of dir.split("/")) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
		}
	}
}

class SettingsTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: SharedKbPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.data.settings;
		const host = s.link ? safeHost(s.link) : "";
		new Setting(containerEl)
			.setName("Status")
			.setDesc(s.link ? `Connected to ${host}${s.who ? ` as ${s.who}` : ""}.` : "Not connected yet. Pair with a code, or paste a link below.");

		new Setting(containerEl).setName("Pair with a code").setHeading();
		let server = host;
		let code = "";
		new Setting(containerEl)
			.setName("Server")
			.setDesc("The knowledge base's address.")
			.addText((t) => t.setPlaceholder("kb.example.com").setValue(server).onChange((v) => (server = v)));
		new Setting(containerEl)
			.setName("Code")
			.setDesc("On a device that's already connected, open the notes in a browser → Devices → Add a device.")
			.addText((t) => t.setPlaceholder("XXXX-XXXX").onChange((v) => (code = v)))
			.addButton((b) =>
				b
					.setButtonText("Pair")
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						try {
							normalizeServer(server);
							await this.plugin.pair(server, code);
							this.display();
						} catch (e) {
							new Notice(`Shared KB: ${e instanceof Error ? e.message : String(e)}`, 10000);
						} finally {
							b.setDisabled(false);
						}
					}),
			);

		new Setting(containerEl).setName("Sync").setHeading();
		new Setting(containerEl)
			.setName("Member link")
			.setDesc("Filled in by pairing. Or paste a private link you were given (it ends in /mcp or /). Anyone with it has your access, so keep it private.")
			.addText((t) =>
				t
					.setPlaceholder("https://…/kb/…/…/")
					.setValue(s.link)
					.onChange(async (v) => {
						s.link = v.trim();
						s.who = "";
						await this.plugin.saveData(this.plugin.data);
					}),
			);
		new Setting(containerEl)
			.setName("Folder")
			.setDesc("Vault folder to sync the knowledge base into. Leave empty to sync the whole vault.")
			.addText((t) =>
				t
					.setPlaceholder("Shared")
					.setValue(s.folder)
					.onChange(async (v) => {
						s.folder = v.trim().replace(/^\/+|\/+$/g, "");
						this.plugin.data.stateLink = undefined; // a new folder needs a fresh first sync
						await this.plugin.saveData(this.plugin.data);
					}),
			);
		new Setting(containerEl).setName("Connect").setDesc("Apply these settings and sync now.").addButton((b) =>
			b
				.setButtonText("Connect & sync")
				.setCta()
				.onClick(async () => {
					await this.plugin.start();
					this.display();
				}),
		);
	}
}

function safeHost(link: string): string {
	try {
		return new URL(link).host;
	} catch {
		return "";
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly message: string,
		private readonly confirmText: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.confirmText)
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
