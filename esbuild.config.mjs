import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["src/main.ts"],
	bundle: true,
	format: "cjs",
	target: "es2022",
	platform: "browser",
	external: ["obsidian", "electron"],
	outfile: "dist/main.js",
	logLevel: "info",
});
