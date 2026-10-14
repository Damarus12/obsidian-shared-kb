import { describe, expect, it } from "vitest";
import { emptyFolders } from "../src/tidy";

describe("emptyFolders", () => {
	const folders = ["Shared", "Shared/a", "Shared/a/b", "Shared/c", "Shared/d", "Shared/d/e", "Shared/.hidden", "Other", "Shared2"];
	const files = ["Shared/c/note.md", "Shared/d/e/pic.png", "Shared2/x.md"];

	it("finds folders under the sync folder with no files at any depth, deepest first", () => {
		expect(emptyFolders(folders, files, "Shared")).toEqual(["Shared/a/b", "Shared/a"]);
	});

	it("never returns the sync folder itself, folders outside it, or dot folders", () => {
		expect(emptyFolders(["Shared", ".obsidian", ".trash"], [], "Shared")).toEqual([]);
		expect(emptyFolders(["Shared", "Other"], [], "Shared")).toEqual([]);
	});

	it("covers the whole vault when the sync folder is empty", () => {
		expect(emptyFolders(["a", "a/b", "c", ".obsidian", ".obsidian/plugins"], ["c/x.md"], "")).toEqual(["a/b", "a"]);
		expect(emptyFolders(["/", "", "a"], [], "")).toEqual(["a"]); // Obsidian's vault root is "/"
	});

	it("keeps a folder whose only file is not a note", () => {
		expect(emptyFolders(["Shared", "Shared/img"], ["Shared/img/cover.png"], "Shared")).toEqual([]);
	});
});
