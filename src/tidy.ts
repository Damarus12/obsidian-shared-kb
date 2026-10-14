/**
 * Before 0.3.1, moving the last note out of a folder could leave the folder behind (empty).
 * The plugin removes those once, after the first sync on a newer version.
 */

/** Folders under `root` (not `root` itself, nor dot folders) with no file at any depth, deepest first. */
export function emptyFolders(folders: string[], files: string[], root: string): string[] {
	const prefix = root ? `${root}/` : "";
	const hasFile = (dir: string) => files.some((f) => f.startsWith(`${dir}/`));
	return folders
		.filter((d) => d !== "" && d !== "/" && d.startsWith(prefix) && d !== root)
		.filter((d) => !d.slice(prefix.length).split("/").some((s) => s.startsWith(".")))
		.filter((d) => !hasFile(d))
		.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
}
