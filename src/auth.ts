import type { Requester } from "./http-api";

// Signing in to a shared-kb server with OAuth (authorization code + PKCE). The browser does the
// passkey sign-in and the "Allow" page; the server's /oauth/obsidian page hands the one-time code
// back through an obsidian://shared-kb-auth link, and the plugin trades it for tokens.

export interface Tokens {
	clientId: string;
	access: string;
	refresh: string;
	/** ms since epoch. */
	expiresAt: number;
}

/** A sign-in the plugin started and is waiting to hear back about. */
export interface PendingSignIn {
	server: string;
	clientId: string;
	verifier: string;
	state: string;
}

export const redirectUri = (server: string) => `${server}/oauth/obsidian`;

function b64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function random(bytes = 32): string {
	return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
	return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Registers the plugin with the server (once per server) and returns the address to open in the browser. */
export async function startSignIn(
	request: Requester,
	server: string,
	clientId: string | undefined,
	deviceName: string,
): Promise<{ url: string; pending: PendingSignIn }> {
	let id = clientId;
	if (!id) {
		const res = await request({
			url: `${server}/register`,
			method: "POST",
			body: JSON.stringify({
				client_name: deviceName,
				redirect_uris: [redirectUri(server)],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
		});
		const out = (res.json ?? {}) as { client_id?: string; error_description?: string };
		if (res.status >= 400 || !out.client_id) throw new Error(`The server didn't accept the plugin: ${out.error_description ?? `HTTP ${res.status}`}`);
		id = out.client_id;
	}
	const pending: PendingSignIn = { server, clientId: id, verifier: random(), state: random(16) };
	const q = new URLSearchParams({
		response_type: "code",
		client_id: id,
		redirect_uri: redirectUri(server),
		scope: "sync",
		state: pending.state,
		code_challenge: await challengeFor(pending.verifier),
		code_challenge_method: "S256",
		resource: server,
	});
	return { url: `${server}/authorize?${q}`, pending };
}

/** The obsidian://shared-kb-auth link came back: check it's for our sign-in and get tokens. */
export async function finishSignIn(request: Requester, pending: PendingSignIn, params: Record<string, string | undefined>, now: number): Promise<Tokens> {
	if (params.state !== pending.state) throw new Error("That sign-in link is for a sign-in this device didn't start. Start again from the plugin's settings.");
	if (params.error) throw new Error(params.error === "access_denied" ? "Not allowed: the sign-in was denied." : `Sign-in failed: ${params.error}`);
	if (!params.code) throw new Error("Sign-in failed: no code came back.");
	return tokenRequest(request, pending.server, pending.clientId, now, {
		grant_type: "authorization_code",
		code: params.code,
		redirect_uri: redirectUri(pending.server),
		client_id: pending.clientId,
		code_verifier: pending.verifier,
		resource: pending.server,
	});
}

async function tokenRequest(request: Requester, server: string, clientId: string, now: number, form: Record<string, string>): Promise<Tokens> {
	const res = await request({ url: `${server}/token`, method: "POST", contentType: "application/x-www-form-urlencoded", body: new URLSearchParams(form).toString() });
	const out = (res.json ?? {}) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
	if (res.status >= 400 || !out.access_token) throw new SignedOut(out.error ?? `HTTP ${res.status}`);
	return { clientId, access: out.access_token, refresh: out.refresh_token ?? form.refresh_token ?? "", expiresAt: now + (out.expires_in ?? 3600) * 1000 };
}

/** The server no longer accepts this device's sign-in (disconnected, signed out everywhere, or unused for a month). */
export class SignedOut extends Error {
	constructor(reason: string) {
		super(`This device was signed out (${reason}). Sign in again in the plugin's settings.`);
	}
}

/** Hands out a valid access token, refreshing (once, however many callers ask) when it's about to expire. */
export class Session {
	private refreshing: Promise<void> | null = null;

	constructor(
		private readonly request: Requester,
		private readonly server: string,
		private tokens: Tokens,
		private readonly save: (tokens: Tokens) => Promise<void>,
		private readonly now: () => number = Date.now,
	) {}

	async token(): Promise<string> {
		if (this.tokens.expiresAt - 60_000 <= this.now()) await this.refresh();
		return this.tokens.access;
	}

	/** Also called when the server answers 401, e.g. after the access token was revoked. */
	refresh(): Promise<void> {
		this.refreshing ??= (async () => {
			try {
				this.tokens = await tokenRequest(this.request, this.server, this.tokens.clientId, this.now(), {
					grant_type: "refresh_token",
					refresh_token: this.tokens.refresh,
					client_id: this.tokens.clientId,
					resource: this.server,
				});
				await this.save(this.tokens);
			} finally {
				this.refreshing = null;
			}
		})();
		return this.refreshing;
	}
}

/** An old private link ("https://host/kb/<id>/<token>/") → the server and knowledge base it pointed at. */
export function fromLegacyLink(link: string): { server: string; kb: string } | null {
	let url: URL;
	try {
		url = new URL(link.trim());
	} catch {
		return null;
	}
	const m = /^\/kb\/([^/]+)\/[^/]+/.exec(url.pathname);
	return m && (url.protocol === "https:" || url.protocol === "http:") ? { server: url.origin, kb: decodeURIComponent(m[1]) } : null;
}

/** Identifies what a vault's sync state belongs to: a new knowledge base starts a fresh sync. */
export function syncKey(server: string, kb: string): string {
	return `${server}/kb/${kb}`;
}
