import { describe, expect, it } from "vitest";
import { deviceLabel, normalizeServer } from "../src/pairing";

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
