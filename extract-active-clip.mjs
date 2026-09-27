/**
 * 提取当前设置的开机动画视频：把解析到的片源另存成一个独立 mp4，并校验完整性。
 * 用法：node extract-active-clip.mjs <输出目录>
 */
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readSplashConfig, resolveSplashClip } from "./assets/dsh-boot-splash-clip.js";

const outDir = process.argv[2] ?? ".";
const clip = resolveSplashClip(readSplashConfig());
if (clip === null) {
	console.log("当前没有可用片源");
	process.exit(1);
}

const buf = readFileSync(clip.path);
const sha = createHash("sha256").update(buf).digest("hex");

// mvhd：时长。tkhd：分辨率（取宽高最大的那条轨道，即视频轨）。
const latin = buf.toString("latin1");
const mvhd = latin.indexOf("mvhd");
let duration = null;
if (mvhd >= 0) {
	const version = buf[mvhd + 4];
	const body = mvhd + 8;
	const timescale = version === 1 ? buf.readUInt32BE(body + 16) : buf.readUInt32BE(body + 8);
	const ticks = version === 1 ? Number(buf.readBigUInt64BE(body + 24)) : buf.readUInt32BE(body + 12);
	if (timescale > 0) duration = ticks / timescale;
}
let width = 0;
let height = 0;
for (let at = latin.indexOf("tkhd"); at >= 0; at = latin.indexOf("tkhd", at + 1)) {
	const version = buf[at + 4];
	const base = at + (version === 1 ? 92 : 80);
	if (base + 8 > buf.length) continue;
	const w = buf.readUInt32BE(base) / 65536;
	const h = buf.readUInt32BE(base + 4) / 65536;
	if (w > width) {
		width = w;
		height = h;
	}
}

const extension = clip.path.slice(clip.path.lastIndexOf("."));
/** 内置片段用 clips.meta.js 里的中文显示名；用户自己的文件用原名。 */
function displayName() {
	if (!clip.source.startsWith("内置片段")) {
		const stem = clip.path.slice(clip.path.lastIndexOf("\\") + 1, clip.path.lastIndexOf("."));
		return ("开机动画-" + stem).replace(/[\\/:*?"<>|]/gu, "-");
	}
	try {
		const meta = readFileSync(
			join(process.env.DSH_HOME ?? join(process.env.USERPROFILE, ".dsh"), "profiles/desktop/node_modules/dsh-boot-animation/lib/clips.meta.js"),
			"utf8"
		);
		const hit = new RegExp(`"id":\\s*"${clip.label}"[\\s\\S]*?"name":\\s*"([^"]+)"`, "u").exec(meta);
		if (hit !== null) return hit[1].replace(/\s+/gu, "");
	} catch {
		// 插件已卸载就拿不到显示名，退回 id。
	}
	return clip.label;
}

const target = join(outDir, `${displayName()}${extension}`);
mkdirSync(outDir, { recursive: true });
copyFileSync(clip.path, target);

console.log("片源来源 :", clip.source);
console.log("原始路径 :", clip.path);
console.log("提取到   :", target);
console.log("字节数   :", statSync(target).size);
console.log("sha256   :", sha);
console.log("时长     :", duration === null ? "未知" : `${duration.toFixed(2)} 秒`);
console.log("分辨率   :", width > 0 ? `${width}x${height}` : "未知");
console.log("moov 前置:", latin.slice(0, 4096).includes("moov"));
