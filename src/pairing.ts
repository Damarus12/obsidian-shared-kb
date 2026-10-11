import type { Requester } from "./http-api";
import { ApiError } from "./sync";

/** "kb.example.com" or any URL on the server → its origin, e.g. "https://kb.example.com". */
export function normalizeServer(input: string): string {
	const raw = input.trim();
	if (!raw) throw new Error("Enter the server address, e.g. kb.example.com.");
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
	} catch {
		throw new Error(`"${raw}" isn't a server address.`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`"${raw}" isn't a web server address.`);
	return url.origin;
}

/** Formats a pairing code as it's typed: uppercase, letters and digits only, "XXXX-XXXX". */
export function formatCode(input: string): string {
	const chars = input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
	return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars;
}

/** Which Obsidian.Platform flags are set. */
export type PlatformFlags = Partial<Record<"isIosApp" | "isAndroidApp" | "isTablet" | "isMacOS" | "isWin" | "isLinux", boolean>>;

/** The name this device gets in the member's device list. */
export function deviceLabel(p: PlatformFlags): string {
	const kind = p.isIosApp ? (p.isTablet ? "iPad" : "iPhone") : p.isAndroidApp ? "Android" : p.isMacOS ? "Mac" : p.isWin ? "Windows" : p.isLinux ? "Linux" : "";
	return kind ? `Obsidian (${kind})` : "Obsidian";
}

/** A member link (web or AI) → the web link the plugin uses, or null if it isn't one. */
export function memberLinkFrom(input: string): string | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	const m = /^\/kb\/[^/]+\/[^/]+\//.exec(url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`);
	return m ? url.origin + m[0] : null;
}

/**
 * Whether two member links point at the same knowledge base (same server and kb id).
 * Then the sync state carries over, e.g. when an old shared link is swapped for this device's own.
 */
export function sameKnowledgeBase(a: string | undefined, b: string): boolean {
	const key = (link: string | undefined) => {
		const web = link ? memberLinkFrom(link) : null;
		return web ? web.replace(/[^/]+\/$/, "") : null;
	};
	const ka = key(a);
	return ka !== null && ka === key(b);
}

export interface PairedDevice {
	name: string;
	role: "read" | "write";
	device: string;
	link: string;
}

/** Trades a one-time code for this device's own member link. */
export async function pairDevice(request: Requester, server: string, code: string, device: string): Promise<PairedDevice> {
	const origin = normalizeServer(server);
	const res = await request({ url: `${origin}/pair/api`, method: "POST", body: JSON.stringify({ code, device }) });
	const out = (res.json ?? {}) as Partial<PairedDevice> & { error?: string; message?: string };
	if (res.status >= 400) throw new ApiError(res.status, out.error ?? "http", out.message ?? `HTTP ${res.status}`);
	const link = typeof out.link === "string" ? memberLinkFrom(out.link) : null;
	if (!link || !link.startsWith(`${origin}/`)) throw new Error("Unexpected response from the server.");
	return { name: String(out.name ?? ""), role: out.role === "read" ? "read" : "write", device: String(out.device ?? ""), link };
}
