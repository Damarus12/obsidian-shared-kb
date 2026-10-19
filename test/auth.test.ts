import { describe, expect, it } from "vitest";
import { finishSignIn, fromLegacyLink, Session, startSignIn, syncKey, type Tokens } from "../src/auth";
import type { Requester } from "../src/http-api";

/** A fake server: records requests, answers from a queue. */
function fakeServer(...answers: Array<{ status: number; json: unknown }>) {
	const calls: Array<Parameters<Requester>[0]> = [];
	const request: Requester = async (req) => {
		calls.push(req);
		const next = answers.shift();
		if (!next) throw new Error(`unexpected request ${req.method} ${req.url}`);
		return next;
	};
	return { calls, request };
}

const form = (body: string | undefined) => Object.fromEntries(new URLSearchParams(body ?? ""));

describe("signing in through the browser", () => {
	it("registers once, then sends the person to the server's sign-in page with PKCE", async () => {
		const { calls, request } = fakeServer({ status: 201, json: { client_id: "client-1" } });
		const { url, pending } = await startSignIn(request, "https://kb.example.com", undefined, "Obsidian (iPhone)");
		expect(calls[0].url).toBe("https://kb.example.com/register");
		expect(JSON.parse(calls[0].body!)).toMatchObject({
			client_name: "Obsidian (iPhone)",
			redirect_uris: ["https://kb.example.com/oauth/obsidian"],
			token_endpoint_auth_method: "none",
		});
		const u = new URL(url);
		expect(u.origin + u.pathname).toBe("https://kb.example.com/authorize");
		expect(Object.fromEntries(u.searchParams)).toMatchObject({
			response_type: "code",
			client_id: "client-1",
			redirect_uri: "https://kb.example.com/oauth/obsidian",
			scope: "sync",
			code_challenge_method: "S256",
			state: pending.state,
			resource: "https://kb.example.com",
		});
		// The challenge is the SHA-256 of the verifier, base64url.
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier)));
		expect(u.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
		expect(pending.verifier.length).toBeGreaterThanOrEqual(43);

		// A known client isn't registered again.
		const again = fakeServer();
		await startSignIn(again.request, "https://kb.example.com", "client-1", "Obsidian");
		expect(again.calls).toHaveLength(0);
	});

	it("trades the code for tokens, only for the sign-in it started", async () => {
		const pending = { server: "https://kb.example.com", clientId: "client-1", verifier: "v".repeat(43), state: "s1" };
		await expect(finishSignIn(fakeServer().request, pending, { state: "other", code: "c" }, 0)).rejects.toThrow(/didn't start/i);
		await expect(finishSignIn(fakeServer().request, pending, { state: "s1", error: "access_denied" }, 0)).rejects.toThrow(/denied|not allowed/i);

		const { calls, request } = fakeServer({ status: 200, json: { access_token: "a1", refresh_token: "r1", expires_in: 3600 } });
		const tokens = await finishSignIn(request, pending, { state: "s1", code: "c1" }, 1_000);
		expect(tokens).toEqual({ clientId: "client-1", access: "a1", refresh: "r1", expiresAt: 1_000 + 3600_000 });
		expect(calls[0].url).toBe("https://kb.example.com/token");
		expect(form(calls[0].body)).toEqual({
			grant_type: "authorization_code",
			code: "c1",
			redirect_uri: "https://kb.example.com/oauth/obsidian",
			client_id: "client-1",
			code_verifier: "v".repeat(43),
			resource: "https://kb.example.com",
		});
	});
});

describe("Session", () => {
	const tokens: Tokens = { clientId: "c", access: "a1", refresh: "r1", expiresAt: 10_000_000 };

	it("uses the access token until it's about to expire, then refreshes and saves", async () => {
		const clock = { t: 0 };
		const saved: Tokens[] = [];
		const { calls, request } = fakeServer({ status: 200, json: { access_token: "a2", refresh_token: "r2", expires_in: 3600 } });
		const s = new Session(request, "https://kb.example.com", { ...tokens }, async (t) => void saved.push(t), () => clock.t);
		expect(await s.token()).toBe("a1");
		clock.t = tokens.expiresAt - 30_000;
		expect(await s.token()).toBe("a2");
		expect(form(calls[0].body)).toEqual({ grant_type: "refresh_token", refresh_token: "r1", client_id: "c", resource: "https://kb.example.com" });
		expect(saved.at(-1)).toMatchObject({ access: "a2", refresh: "r2" });
	});

	it("says so when the sign-in ended (refresh refused)", async () => {
		const { request } = fakeServer({ status: 400, json: { error: "invalid_grant" } });
		const s = new Session(request, "https://kb.example.com", { ...tokens, expiresAt: 0 }, async () => {}, () => 1);
		await expect(s.token()).rejects.toThrow(/sign in again/i);
	});

	it("refreshes only once when several requests need it at the same time", async () => {
		const { calls, request } = fakeServer({ status: 200, json: { access_token: "a2", refresh_token: "r2", expires_in: 3600 } });
		const s = new Session(request, "https://kb.example.com", { ...tokens, expiresAt: 0 }, async () => {}, () => 1);
		expect(await Promise.all([s.token(), s.token(), s.token()])).toEqual(["a2", "a2", "a2"]);
		expect(calls).toHaveLength(1);
	});
});

describe("settings from before sign-in", () => {
	it("reads the server and knowledge base out of an old private link", () => {
		expect(fromLegacyLink("https://kb.example.com/kb/abc123/Tok3n/")).toEqual({ server: "https://kb.example.com", kb: "abc123" });
		expect(fromLegacyLink("https://kb.example.com/kb/abc123/Tok3n/mcp")).toEqual({ server: "https://kb.example.com", kb: "abc123" });
		expect(fromLegacyLink("")).toBeNull();
		expect(fromLegacyLink("https://kb.example.com/elsewhere")).toBeNull();
	});

	it("keeps what's synced when it's the same knowledge base", () => {
		expect(syncKey("https://kb.example.com", "abc")).toBe("https://kb.example.com/kb/abc");
		expect(syncKey("https://kb.example.com", "abc")).toBe(syncKey(fromLegacyLink("https://kb.example.com/kb/abc/t/")!.server, "abc"));
	});
});
