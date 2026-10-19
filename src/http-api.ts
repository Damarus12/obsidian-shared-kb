import { ApiError, type Api, type Change, type RemoteNote } from "./sync";

export type Requester = (req: {
	url: string;
	method: string;
	body?: string;
	/** Defaults to application/json. */
	contentType?: string;
	headers?: Record<string, string>;
}) => Promise<{ status: number; json: unknown }>;

/** Where tokens come from (see auth.ts Session). */
export interface TokenSource {
	token(): Promise<string>;
	refresh(): Promise<void>;
}

/**
 * The plugin's side of the server's JSON API, at `<server>/api/<kb>/`. `request` is Obsidian's
 * requestUrl in the app, fetch in tests. A 401 (e.g. the access token was revoked) refreshes once and retries.
 */
export class HttpApi implements Api {
	constructor(
		private readonly base: string,
		private readonly request: Requester,
		private readonly auth: TokenSource,
	) {}

	changes(since: number) {
		return this.call<{ changes: Change[]; cursor: number; more: boolean }>("GET", `changes?since=${since}`);
	}
	get(path: string) {
		return this.call<RemoteNote>("GET", `note?path=${encodeURIComponent(path)}`);
	}
	put(path: string, content: string, baseVersion: number | null) {
		return this.call<RemoteNote>("PUT", "note", { path, content, base_version: baseVersion });
	}
	move(path: string, newPath: string, baseVersion: number) {
		return this.call<RemoteNote>("POST", "move", { path, new_path: newPath, base_version: baseVersion });
	}
	delete(path: string, baseVersion: number) {
		return this.call("DELETE", `note?path=${encodeURIComponent(path)}&base_version=${baseVersion}`);
	}
	me() {
		return this.call<{ name: string; role: "read" | "write"; owner?: boolean }>("GET", "me");
	}
	/** A one-minute ticket for the live-updates WebSocket. */
	wsTicket() {
		return this.call<{ ticket: string }>("POST", "ws-ticket");
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const send = async () =>
			this.request({
				url: this.base + path,
				method,
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: { Authorization: `Bearer ${await this.auth.token()}` },
			});
		let res = await send();
		if (res.status === 401) {
			await this.auth.refresh();
			res = await send();
		}
		if (res.status >= 400) {
			const err = (res.json ?? {}) as { error?: string; message?: string };
			throw new ApiError(res.status, err.error ?? "http", err.message ?? `HTTP ${res.status}`);
		}
		return res.json as T;
	}
}

/** The knowledge bases the signed-in person belongs to (any token with the sync scope). */
export async function listKnowledgeBases(request: Requester, server: string, auth: TokenSource): Promise<{ name: string; kbs: Array<{ id: string; name: string }> }> {
	const res = await request({ url: `${server}/api/me`, method: "GET", headers: { Authorization: `Bearer ${await auth.token()}` } });
	const out = (res.json ?? {}) as { name?: string; kbs?: Array<{ id: string; name: string }>; error?: string; message?: string };
	if (res.status >= 400) throw new ApiError(res.status, out.error ?? "http", out.message ?? `HTTP ${res.status}`);
	return { name: out.name ?? "", kbs: out.kbs ?? [] };
}
