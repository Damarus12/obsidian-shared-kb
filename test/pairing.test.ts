import { describe, expect, it } from "vitest";
import { deviceLabel, formatCode, memberLinkFrom, normalizeServer, pairDevice, sameKnowledgeBase } from "../src/pairing";
import { ApiError } from "../src/sync";
import type { Requester } from "../src/http-api";

describe("normalizeServer", () => {
	it("accepts a bare host or a URL and returns its origin", () => {
		expect(normalizeServer("kb.example.com")).toBe("https://kb.example.com");
		expect(normalizeServer(" https://kb.example.com/pair#AAAA ")).toBe("https://kb.example.com");
		expect(normalizeServer("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
	});

	it("rejects nothing and non-web addresses", () => {
		expect(() => normalizeServer("")).toThrow(/server/i);
		expect(() => normalizeServer("ftp://x.com")).toThrow(/server/i);
	});
});

describe("deviceLabel", () => {
	it("names the device after the platform", () => {
		expect(deviceLabel({ isIosApp: true, isTablet: false })).toBe("Obsidian (iPhone)");
		expect(deviceLabel({ isIosApp: true, isTablet: true })).toBe("Obsidian (iPad)");
		expect(deviceLabel({ isAndroidApp: true })).toBe("Obsidian (Android)");
		expect(deviceLabel({ isMacOS: true })).toBe("Obsidian (Mac)");
		expect(deviceLabel({ isWin: true })).toBe("Obsidian (Windows)");
		expect(deviceLabel({})).toBe("Obsidian");
	});
});

describe("memberLinkFrom", () => {
	it("accepts web and AI member links and returns the web link", () => {
		expect(memberLinkFrom("https://kb.example.com/kb/abc123/Tok3n/")).toBe("https://kb.example.com/kb/abc123/Tok3n/");
		expect(memberLinkFrom("https://kb.example.com/kb/abc123/Tok3n/mcp")).toBe("https://kb.example.com/kb/abc123/Tok3n/");
	});

	it("rejects anything that isn't a member link", () => {
		expect(memberLinkFrom("https://evil.example.com/steal")).toBeNull();
		expect(memberLinkFrom("javascript:alert(1)")).toBeNull();
		expect(memberLinkFrom("")).toBeNull();
	});
});

describe("formatCode", () => {
	it("uppercases and adds the dash as you type", () => {
		expect(formatCode("k")).toBe("K");
		expect(formatCode("k7p2")).toBe("K7P2");
		expect(formatCode("k7p2q")).toBe("K7P2-Q");
		expect(formatCode("k7p2qx9m")).toBe("K7P2-QX9M");
	});

	it("cleans up pasted codes and stops at 8 characters", () => {
		expect(formatCode(" k7p2 - qx9m ")).toBe("K7P2-QX9M");
		expect(formatCode("K7P2-QX9M-EXTRA")).toBe("K7P2-QX9M");
	});

	it("lets backspace remove the dash", () => {
		expect(formatCode("K7P2-")).toBe("K7P2");
	});
});

describe("sameKnowledgeBase", () => {
	it("treats a new device link for the same knowledge base as the same sync target", () => {
		expect(sameKnowledgeBase("https://kb.example.com/kb/abc/old/", "https://kb.example.com/kb/abc/new/")).toBe(true);
		expect(sameKnowledgeBase("https://kb.example.com/kb/abc/t/", "https://kb.example.com/kb/xyz/t/")).toBe(false);
		expect(sameKnowledgeBase("https://a.example.com/kb/abc/t/", "https://b.example.com/kb/abc/t/")).toBe(false);
		expect(sameKnowledgeBase(undefined, "https://kb.example.com/kb/abc/t/")).toBe(false);
	});
});

describe("pairDevice", () => {
	it("redeems the code at the server and returns the new link", async () => {
		const calls: Array<{ url: string; body?: string }> = [];
		const request: Requester = async (req) => {
			calls.push(req);
			return { status: 200, json: { name: "Sean", role: "write", device: "Obsidian (iPhone)", link: "https://kb.example.com/kb/k/t/", mcp: "https://kb.example.com/kb/k/t/mcp" } };
		};
		const out = await pairDevice(request, "kb.example.com", "k7p2-qx9m", "Obsidian (iPhone)");
		expect(out).toMatchObject({ name: "Sean", link: "https://kb.example.com/kb/k/t/" });
		expect(calls[0].url).toBe("https://kb.example.com/pair/api");
		expect(JSON.parse(calls[0].body!)).toEqual({ code: "k7p2-qx9m", device: "Obsidian (iPhone)" });
	});

	it("passes the server's message on failure", async () => {
		const request: Requester = async () => ({ status: 404, json: { error: "not_found", message: "That code is not valid." } });
		await expect(pairDevice(request, "kb.example.com", "x", "d")).rejects.toThrow(new ApiError(404, "not_found", "That code is not valid."));
	});

	it("refuses a response that doesn't contain a member link", async () => {
		const request: Requester = async () => ({ status: 200, json: { link: "https://elsewhere.example.com/x" } });
		await expect(pairDevice(request, "kb.example.com", "x", "d")).rejects.toThrow(/unexpected/i);
	});
});
