import { ApiError, type Api, type Change, type RemoteNote } from "./sync";

export type Requester = (req: { url: string; method: string; body?: string }) => Promise<{ status: number; json: unknown }>;

/** The plugin's side of the server's JSON API. `request` is Obsidian's requestUrl in the app, fetch in tests. */
export class HttpApi implements Api {
	constructor(
		private readonly base: string,
		private readonly request: Requester,
	) {}

	changes(since: number) {
		return this.call<{ changes: Change[]; cursor: number; more: boolean }>("GET", `api/changes?since=${since}`);
	}
	get(path: string) {
		return this.call<RemoteNote>("GET", `api/note?path=${encodeURIComponent(path)}`);
	}
	put(path: string, content: string, baseVersion: number | null) {
		return this.call<RemoteNote>("PUT", "api/note", { path, content, base_version: baseVersion });
	}
	move(path: string, newPath: string, baseVersion: number) {
		return this.call<RemoteNote>("POST", "api/move", { path, new_path: newPath, base_version: baseVersion });
	}
	delete(path: string, baseVersion: number) {
		return this.call("DELETE", `api/note?path=${encodeURIComponent(path)}&base_version=${baseVersion}`);
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await this.request({ url: this.base + path, method, body: body === undefined ? undefined : JSON.stringify(body) });
		if (res.status >= 400) {
			const err = (res.json ?? {}) as { error?: string; message?: string };
			throw new ApiError(res.status, err.error ?? "http", err.message ?? `HTTP ${res.status}`);
		}
		return res.json as T;
	}
}
