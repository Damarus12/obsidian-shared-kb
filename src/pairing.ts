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

/** Which Obsidian.Platform flags are set. */
export type PlatformFlags = Partial<Record<"isIosApp" | "isAndroidApp" | "isTablet" | "isMacOS" | "isWin" | "isLinux", boolean>>;

/** The name this device's app gets on the person's account page. */
export function deviceLabel(p: PlatformFlags): string {
	const kind = p.isIosApp ? (p.isTablet ? "iPad" : "iPhone") : p.isAndroidApp ? "Android" : p.isMacOS ? "Mac" : p.isWin ? "Windows" : p.isLinux ? "Linux" : "";
	return kind ? `Obsidian (${kind})` : "Obsidian";
}
