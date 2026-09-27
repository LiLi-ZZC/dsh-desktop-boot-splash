/**
 * 片源解析自测：node test-resolve.mjs
 * 不依赖 Electron，直接验证「片库选中 builtin:cyberpunk → 解出可播放的 mp4」。
 */
import { readFileSync, statSync } from "node:fs";
import { bootAnimationDir, mimeFor, parseRangeHeader, readMainWindowBounds, readSplashConfig, resolveSplashClip } from "./assets/dsh-boot-splash-clip.js";

const config = readSplashConfig();
console.log("config      :", JSON.stringify(config));
console.log("boot dir    :", bootAnimationDir());

const clip = resolveSplashClip(config);
if (clip === null) {
	console.log("clip        : (none)");
	process.exit(1);
}
const size = statSync(clip.path).size;
const header = readFileSync(clip.path).subarray(0, 4096).toString("latin1");
console.log("clip source :", clip.source);
console.log("clip path   :", clip.path);
console.log("clip bytes  :", size);
console.log("ftyp at 4   :", header.slice(4, 8));
// faststart 检查：moov 应该出现在文件靠前的位置，否则浏览器要下完整段才出画面。
console.log("moov early  :", header.includes("moov"));
if (size < 1024 || header.slice(4, 8) !== "ftyp") {
	console.log("FAIL: not a usable mp4");
	process.exit(1);
}
console.log("bounds      :", JSON.stringify(readMainWindowBounds(process.env.APPDATA + "\\DSH Desktop")));

// Range 解析（自定义协议唯一容易写错的地方）
const cases = [
	["bytes=0-", 1000, { start: 0, end: 999 }],
	["bytes=0-1023", 1000, { start: 0, end: 999 }],
	["bytes=500-600", 1000, { start: 500, end: 600 }],
	["bytes=-200", 1000, { start: 800, end: 999 }],
	["bytes=1000-", 1000, "invalid"],
	["bytes=600-500", 1000, "invalid"],
	["", 1000, null],
	["items=0-1", 1000, "invalid"]
];
let bad = 0;
for (const [header, size, expected] of cases) {
	const actual = parseRangeHeader(header, size);
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) bad += 1;
	console.log(`${ok ? "ok  " : "FAIL"} range ${JSON.stringify(header)} -> ${JSON.stringify(actual)}`);
}
console.log("mime        :", mimeFor(clip.path));
if (bad > 0) process.exit(1);
console.log("OK");
