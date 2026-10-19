import { describe, expect, it } from "vitest";
import { HttpApi, listKnowledgeBases, type Requester, type TokenSource } from "../src/http-api";
import { ApiError } from "../src/sync";

function tokens(...values: string[]): TokenSource & { refreshed: number } {
	let i = 0;
	return {
		refreshed: 0,
		async token() {
			return values[Math.min(i, values.length - 1)];
		},
		async refresh() {
			this.refreshed++;
			i++;
		},
	};
}

describe("HttpApi", () => {
	it("calls /api/<kb>/ with the access token", async () => {
		const calls: Array<Parameters<Requester>[0]> = [];
		const request: Requester = async (req) => {
			calls.push(req);
			return { status: 200, json: { path: "a.md", version: 1 } };
		};
		const api = new HttpApi("https://kb.example.com/api/abc/", request, tokens("t1"));
		await api.put("a.md", "x", null);
		expect(calls[0]).toMatchObject({ url: "https://kb.example.com/api/abc/note", method: "PUT", headers: { Authorization: "Bearer t1" } });
		expect(JSON.parse(calls[0].body!)).toEqual({ path: "a.md", content: "x", base_version: null });
	});

	it("refreshes once and retries after a 401", async () => {
		const seen: string[] = [];
		const request: Requester = async (req) => {
			seen.push(req.headers!.Authorization);
			return req.headers!.Authorization === "Bearer old" ? { status: 401, json: { error: "invalid_token" } } : { status: 200, json: { changes: [], cursor: 0, more: false } };
		};
		const auth = tokens("old", "new");
		await new HttpApi("https://kb.example.com/api/abc/", request, auth).changes(0);
		expect(seen).toEqual(["Bearer old", "Bearer new"]);
		expect(auth.refreshed).toBe(1);
	});

	it("passes the server's error on", async () => {
		const request: Requester = async () => ({ status: 403, json: { error: "forbidden", message: "No write access." } });
		await expect(new HttpApi("https://kb.example.com/api/abc/", request, tokens("t")).put("a.md", "x", null)).rejects.toThrow(
			new ApiError(403, "forbidden", "No write access."),
		);
	});
});

describe("listKnowledgeBases", () => {
	it("lists the person's knowledge bases", async () => {
		const request: Requester = async (req) => {
			expect(req.url).toBe("https://kb.example.com/api/me");
			return { status: 200, json: { name: "Alex", kbs: [{ id: "abc", name: "Game dev", member_name: "Alex", owner: true }] } };
		};
		expect(await listKnowledgeBases(request, "https://kb.example.com", tokens("t"))).toMatchObject({ name: "Alex", kbs: [{ id: "abc", name: "Game dev" }] });
	});
});
