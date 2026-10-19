import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import { finishSignIn, fromLegacyLink, Session, SignedOut, startSignIn, syncKey, type PendingSignIn, type Tokens } from "./auth";
import { HttpApi, listKnowledgeBases, type Requester } from "./http-api";
import { deviceLabel, normalizeServer } from "./pairing";
import { ApiError, emptyState, SyncEngine, type LocalFiles, type SyncState } from "./sync";
import { emptyFolders } from "./tidy";

interface Settings {
	/** The server, e.g. https://kb.example.com */
	server: string;
	/** Which knowledge base on it (its id). */
	kb: string;
	/** Its name, for display. */
	kbName: string;
	/** Vault folder that mirrors the knowledge base ("" = whole vault). */
	folder: string;
	/** Who is signed in, e.g. "Alex" (display only). */
	who: string;
	/** Before 0.4.0: a private link. Read once for the server and knowledge base, then removed. */
	link?: string;
}

interface Data {
	settings: Settings;
	state: SyncState;
	/** What the sync state belongs to (server + knowledge base); a different one starts a fresh sync. */
	stateKey?: string;
	/** Before 0.4.0: the link the state belonged to. */
	stateLink?: string;
	/** Empty folders left by versions before 0.3.1 were removed (done once, after a sync). */
	tidied?: boolean;
	/** This device's sign-in. Works like a password: anyone with it can sync as you. */
	auth?: Tokens & { server: string };
	/** A sign-in started in the browser, waiting for the obsidian://shared-kb-auth link. */
	pendingSignIn?: PendingSignIn;
}

const DEFAULTS: Settings = { server: "", kb: "", kbName: "", folder: "", who: "" };

/** requestUrl skips CORS and works on mobile; errors come back as status codes. */
const obsidianRequest: Requester = async ({ url, method, body, contentType, headers }) => {
	const res = await requestUrl({ url, method, body, contentType: contentType ?? "application/json", headers, throw: false });
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
	private api: HttpApi | null = null;
	private files: VaultFiles | null = null;
	private socket: WebSocket | null = null;
	private retry = 0;
	private retryTimer: number | null = null;
	private pending = new Map<string, number>();
	/** Files the server refused this session, so each gets one notice. */
	private denied = new Set<string>();
	private statusEl: HTMLElement | null = null;
	private settingsTab: SettingsTab | null = null;

	async onload(): Promise<void> {
		const saved = (await this.loadData()) as Partial<Data> | null;
		this.data = {
			settings: { ...DEFAULTS, ...saved?.settings },
			state: saved?.state ?? emptyState(),
			stateKey: saved?.stateKey,
			stateLink: saved?.stateLink,
			// Only vaults that synced before can have leftovers; a new install never touches existing folders.
			tidied: saved?.tidied ?? !(saved?.state && saved.state.cursor > 0),
			auth: saved?.auth,
			pendingSignIn: saved?.pendingSignIn,
		};
		await this.fromPrivateLink();
		this.statusEl = this.addStatusBarItem();
		this.settingsTab = new SettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
		this.addCommand({
			id: "open-in-browser",
			name: "Open knowledge base in browser",
			callback: () => {
				const { server, kb } = this.data.settings;
				if (server && kb) window.open(`${server}/kb/${encodeURIComponent(kb)}/`);
			},
		});
		// The server's /oauth/obsidian page sends the browser here after "Allow".
		this.registerObsidianProtocolHandler("shared-kb-auth", (params) => void this.finishSignIn(params));
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

	/**
	 * Before 0.4.0 the plugin used a private link. Servers now use sign-in, so keep only the server and
	 * knowledge base from it (and what's synced, if it's the same one), and forget the link itself.
	 */
	private async fromPrivateLink(): Promise<void> {
		const s = this.data.settings;
		if (!s.link) return;
		const old = fromLegacyLink(s.link);
		if (old && !s.server) Object.assign(s, { server: old.server, kb: old.kb });
		const was = this.data.stateLink ? fromLegacyLink(this.data.stateLink) : null;
		if (was && !this.data.stateKey) this.data.stateKey = syncKey(was.server, was.kb);
		delete s.link;
		delete this.data.stateLink;
		s.who = "";
		await this.saveData(this.data);
	}

	/** (Re)connects with the current settings. */
	async start(): Promise<void> {
		this.stop();
		const { server, kb } = this.data.settings;
		const auth = this.data.auth;
		if (!server) return this.status("not set up");
		if (!auth || auth.server !== server) return this.status("sign in needed");
		if (!kb) return this.status("choose a knowledge base");
		const key = syncKey(server, kb);
		if (this.data.stateKey !== key) {
			this.data.state = emptyState();
			this.data.stateKey = key;
		}
		const session = new Session(obsidianRequest, server, auth, async (t) => {
			this.data.auth = { ...t, server };
			await this.saveData(this.data);
		});
		this.api = new HttpApi(`${server}/api/${encodeURIComponent(kb)}/`, obsidianRequest, session);
		this.files = new VaultFiles(this.app, this.data.settings.folder);
		this.engine = new SyncEngine(this.api, this.files, this.data.state, () => this.saveData(this.data), {
			onConflict: (path, copy) => new Notice(`Shared KB: "${path}" changed on the server while you edited it. Your version is in "${copy}".`, 15000),
			onDenied: (path) => {
				if (this.denied.has(path)) return;
				this.denied.add(path);
				new Notice(`Shared KB: you can't change "${path}" (no write access to that folder). It isn't synced.`, 15000);
			},
			onError: (e) => this.fail(e),
		});
		await this.syncNow();
		this.connect();
		if (!this.data.settings.who) await this.lookupWho();
	}

	/** Fills in who is signed in, for the settings tab. */
	private async lookupWho(): Promise<void> {
		try {
			const me = await this.api?.me();
			if (!me?.name) return;
			this.data.settings.who = `${me.name}${me.role === "read" ? " (read-only)" : ""}`;
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
			await this.tidyOnce();
			this.status("synced");
		} catch (e) {
			this.fail(e, true);
		}
	}

	/** Removes empty folders that versions before 0.3.1 left behind after notes moved. Runs once per vault. */
	private async tidyOnce(): Promise<void> {
		if (this.data.tidied || !this.files) return;
		await this.files.removeEmptyFolders();
		this.data.tidied = true;
		await this.saveData(this.data);
	}

	/** Opens the server's sign-in page in the browser; it comes back through obsidian://shared-kb-auth. */
	async signIn(serverInput: string): Promise<void> {
		const server = normalizeServer(serverInput);
		const known = this.data.auth?.server === server ? this.data.auth.clientId : this.data.pendingSignIn?.server === server ? this.data.pendingSignIn.clientId : undefined;
		const { url, pending } = await startSignIn(obsidianRequest, server, known, deviceLabel(Platform));
		if (this.data.settings.server !== server) Object.assign(this.data.settings, { server, kb: "", kbName: "", who: "" });
		this.data.pendingSignIn = pending;
		await this.saveData(this.data);
		window.open(url);
	}

	private async finishSignIn(params: Record<string, string>): Promise<void> {
		const pending = this.data.pendingSignIn;
		try {
			if (!pending) throw new Error("No sign-in is waiting. Start it from the plugin's settings.");
			const tokens = await finishSignIn(obsidianRequest, pending, params, Date.now());
			this.data.auth = { ...tokens, server: pending.server };
			delete this.data.pendingSignIn;
			await this.saveData(this.data);
			// Pick the knowledge base: the one already chosen if it's still there, else the only one.
			const session = new Session(obsidianRequest, pending.server, tokens, async () => {});
			const { name, kbs } = await listKnowledgeBases(obsidianRequest, pending.server, session);
			const s = this.data.settings;
			const chosen = kbs.find((k) => k.id === s.kb) ?? (kbs.length === 1 ? kbs[0] : undefined);
			Object.assign(s, { kb: chosen?.id ?? "", kbName: chosen?.name ?? "", who: name });
			await this.saveData(this.data);
			new Notice(chosen ? `Shared KB: signed in as ${name}. Syncing "${chosen.name}".` : `Shared KB: signed in as ${name}. Choose a knowledge base in the plugin's settings.`);
			this.settingsTab?.display();
			await this.start();
		} catch (e) {
			new Notice(`Shared KB: ${e instanceof Error ? e.message : String(e)}`, 15000);
		}
	}

	/** Forgets this device's sign-in. (To disconnect it on the server too: your account page there.) */
	async signOut(): Promise<void> {
		this.stop();
		delete this.data.auth;
		this.data.settings.who = "";
		await this.saveData(this.data);
		this.status("signed out");
	}

	/** The knowledge bases this sign-in can sync, for the settings tab. */
	async knowledgeBases(): Promise<Array<{ id: string; name: string }>> {
		const auth = this.data.auth;
		if (!auth) return [];
		const session = new Session(obsidianRequest, auth.server, auth, async (t) => {
			this.data.auth = { ...t, server: auth.server };
			await this.saveData(this.data);
		});
		return (await listKnowledgeBases(obsidianRequest, auth.server, session)).kbs;
	}

	private stop(): void {
		if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.socket?.close();
		this.socket = null;
		for (const t of this.pending.values()) window.clearTimeout(t);
		this.pending.clear();
		this.engine = null;
		this.api = null;
		this.files = null;
	}

	/** Live updates: the server sends {type:"changed"} after every write. Each connection needs a fresh one-minute ticket. */
	private connect(): void {
		const engine = this.engine;
		const api = this.api;
		const { server, kb } = this.data.settings;
		if (!engine || !api) return;
		const retry = () => {
			if (this.engine !== engine) return; // replaced or stopped
			this.status("offline, retrying");
			const delay = Math.min(60000, 1000 * 2 ** this.retry++);
			this.retryTimer = window.setTimeout(() => this.connect(), delay);
		};
		api.wsTicket().then(
			({ ticket }) => {
				if (this.engine !== engine) return;
				const ws = new WebSocket(`${server.replace(/^http/, "ws")}/ws/${encodeURIComponent(kb)}?ticket=${encodeURIComponent(ticket)}`);
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
					// Access changed: the pull sees a new scope and syncs the folders again.
					if (msg.type === "access") {
						this.denied.clear();
						this.track(engine.pull());
					}
				};
				ws.onclose = () => {
					if (ping !== null) window.clearInterval(ping);
					if (this.socket !== ws) return;
					retry();
				};
			},
			(e) => {
				if (e instanceof SignedOut) return this.fail(e, true);
				retry();
			},
		);
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
		if (e instanceof SignedOut) {
			this.stop();
			this.status("sign in needed");
			if (notify) new Notice(`Shared KB: ${e.message}`, 15000);
			return;
		}
		this.status("error");
		if (!notify) return;
		const msg =
			e instanceof ApiError && e.status === 404
				? "That knowledge base isn't on your account (any more). Choose another in the plugin's settings."
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

	/**
	 * After a sync removes or moves a file away, trash folders it left empty (never the sync folder itself).
	 * Tidying only: a folder that can't be removed stays, and the sync carries on.
	 * (vault.delete(folder) fails with EISDIR on Windows, so folders go through trashFile like files do.)
	 */
	private async pruneEmpty(filePath: string): Promise<void> {
		const root = this.folder ? normalizePath(this.folder) : "";
		let dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
		while (dir && dir !== root) {
			const folder = this.app.vault.getAbstractFileByPath(dir);
			if (!(folder instanceof TFolder) || folder.children.length > 0) return;
			try {
				await this.app.fileManager.trashFile(folder);
			} catch (e) {
				console.warn(`Shared KB: couldn't remove empty folder ${dir}`, e);
				return;
			}
			dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
		}
	}

	/** Trashes every empty folder inside the sync folder (see tidy.ts). */
	async removeEmptyFolders(): Promise<void> {
		const all = this.app.vault.getAllLoadedFiles();
		const folders = all.filter((f) => f instanceof TFolder).map((f) => f.path);
		const files = all.filter((f) => f instanceof TFile).map((f) => f.path);
		for (const dir of emptyFolders(folders, files, this.folder ? normalizePath(this.folder) : "")) {
			const folder = this.app.vault.getAbstractFileByPath(dir);
			if (!(folder instanceof TFolder)) continue; // already went with an emptied parent
			try {
				await this.app.fileManager.trashFile(folder);
			} catch (e) {
				console.warn(`Shared KB: couldn't remove empty folder ${dir}`, e);
			}
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
		const data = this.plugin.data;
		const s = data.settings;
		const signedIn = !!data.auth && data.auth.server === s.server;
		const host = s.server ? safeHost(s.server) : "";
		new Setting(containerEl)
			.setName("Status")
			.setDesc(
				!s.server
					? "Not connected yet. Enter your knowledge base's server address and sign in."
					: !signedIn
						? `Sign in to ${host} to sync.`
						: s.kb
							? `Syncing "${s.kbName || s.kb}" on ${host}${s.who ? ` as ${s.who}` : ""}.`
							: `Signed in to ${host}. Choose a knowledge base below.`,
			);

		new Setting(containerEl).setName("Sign in").setHeading();
		let server = s.server ? host : "";
		new Setting(containerEl)
			.setName("Server")
			.setDesc("Your knowledge base's address, e.g. kb.example.com.")
			.addText((t) => t.setPlaceholder("kb.example.com").setValue(server).onChange((v) => (server = v)));
		new Setting(containerEl)
			.setName(signedIn ? "Signed in" : "Sign in with your passkey")
			.setDesc(
				signedIn
					? "To stop this device syncing, sign out here. To disconnect it on the server too, use your account page there."
					: "Opens your browser: sign in with your passkey and tap Allow, then come back to Obsidian. New here? Open the invite link you were sent first.",
			)
			.addButton((b) =>
				b
					.setButtonText(signedIn ? "Sign in again" : "Sign in")
					.setCta()
					.onClick(async () => {
						try {
							await this.plugin.signIn(server);
						} catch (e) {
							new Notice(`Shared KB: ${e instanceof Error ? e.message : String(e)}`, 10000);
						}
					}),
			)
			.addButton((b) =>
				b
					.setButtonText("Sign out")
					.setDisabled(!signedIn)
					.onClick(async () => {
						await this.plugin.signOut();
						this.display();
					}),
			);

		new Setting(containerEl).setName("Sync").setHeading();
		const kbSetting = new Setting(containerEl).setName("Knowledge base").setDesc(signedIn ? "Loading…" : "Sign in first.");
		if (signedIn) {
			void this.plugin.knowledgeBases().then(
				(kbs) => {
					kbSetting.setDesc(kbs.length ? "Which knowledge base this vault syncs with." : "Your account isn't in any knowledge base yet. Ask for an invite.");
					if (!kbs.length) return;
					kbSetting.addDropdown((d) => {
						if (!kbs.some((k) => k.id === s.kb)) d.addOption("", "Choose…");
						for (const k of kbs) d.addOption(k.id, k.name);
						d.setValue(s.kb).onChange(async (id) => {
							const k = kbs.find((x) => x.id === id);
							Object.assign(s, { kb: k?.id ?? "", kbName: k?.name ?? "" });
							await this.plugin.saveData(this.plugin.data);
						});
					});
				},
				(e) => kbSetting.setDesc(`Couldn't load your knowledge bases: ${e instanceof Error ? e.message : String(e)}`),
			);
		}
		new Setting(containerEl)
			.setName("Folder")
			.setDesc("The vault folder for the shared notes. Leave empty to use the whole vault. If you change it later, the notes are downloaded again into the new folder and the old one is left as it is.")
			.addText((t) =>
				t
					.setPlaceholder("Shared")
					.setValue(s.folder)
					.onChange(async (v) => {
						s.folder = v.trim().replace(/^\/+|\/+$/g, "");
						this.plugin.data.stateKey = undefined; // a new folder needs a fresh first sync
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
