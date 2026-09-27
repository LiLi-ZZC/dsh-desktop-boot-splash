/**
 * 把插件自带的四段内置片头全部提取成真实 mp4 文件。
 * 这些片段只以 base64 存在插件的 lib/clips.data.js 里 —— 一旦卸载插件就没有了，
 * 所以卸载前先留一份底。用法：node extract-builtin-clips.mjs <输出目录>
 */
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveBuiltinClip } from "./assets/dsh-boot-splash-clip.js";

const outDir = process.argv[2] ?? "extracted-builtin";
const metaPath = join(
	process.env.DSH_HOME ?? join(process.env.USERPROFILE, ".dsh"),
	"profiles/desktop/node_modules/dsh-boot-animation/lib/clips.meta.js"
);
const meta = readFileSync(metaPath, "utf8");
const entries = [...meta.matchAll(/"id":\s*"([\w-]+)"[\s\S]*?"name":\s*"([^"]+)"[\s\S]*?"bytes":\s*(\d+)[\s\S]*?"sha256":\s*"(\w+)"/gu)];

mkdirSync(outDir, { recursive: true });
let ok = 0;
for (const [, id, name, bytes, sha] of entries) {
	const clip = resolveBuiltinClip(id);
	if (clip === null) {
		console.log(`FAIL ${id}: 解析失败`);
		continue;
	}
	const target = join(outDir, `${name.replace(/\s+/gu, "")}.mp4`);
	copyFileSync(clip.path, target);
	const actual = createHash("sha256").update(readFileSync(target)).digest("hex");
	const size = statSync(target).size;
	const match = actual.startsWith(sha) && size === Number(bytes);
	if (match) ok += 1;
	console.log(`${match ? "ok  " : "FAIL"} ${id.padEnd(10)} ${name}  ${size} bytes  sha256=${actual.slice(0, 16)} (期望 ${sha})`);
}
console.log(`\n${ok}/${entries.length} 段提取并校验通过 -> ${outDir}`);
process.exit(ok === entries.length ? 0 : 1);
