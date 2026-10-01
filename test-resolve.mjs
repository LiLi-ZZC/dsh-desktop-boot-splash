/**
 * 片源解析自测：node test-resolve.mjs
 * 不依赖 Electron，直接验证「片库选中 builtin:cyberpunk → 解出可播放的 mp4」。
 */
import { readFileSync, statSync } from "node:fs";
import { bootAnimationDir, computeSplashBounds, mimeFor, parseRangeHeader, readMainWindowBounds, readSplashConfig, resolveSplashClip } from "./assets/dsh-boot-splash-clip.js";

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

// 启动窗几何：必须和「主窗口马上会变成的样子」一致，否则动画会只占中间一块、或盖住任务栏。
// 参考环境：2560x1440 屏 + 48px 任务栏 → 工作区 {0,0,2560,1392}，整屏 {0,0,2560,1440}。
const workArea = { x: 0, y: 0, width: 2560, height: 1392 };
const displayBounds = { x: 0, y: 0, width: 2560, height: 1440 };
const saved = { x: 69, y: 5, width: 1877, height: 1097 };
const geometry = [
	["上次最大化 -> 铺满工作区", { savedBounds: saved, windowState: { maximized: true }, workArea, displayBounds }, workArea],
	["上次全屏   -> 铺满整屏", { savedBounds: saved, windowState: { fullScreen: true }, workArea, displayBounds }, displayBounds],
	["普通窗口   -> 原样跟随", { savedBounds: saved, windowState: { maximized: false }, workArea, displayBounds }, saved],
	["窗口拖到偏下（还有 2/3 可见）-> 仍然跟随，不挪位置", { savedBounds: { x: 69, y: 700, width: 1877, height: 1097 }, windowState: null, workArea, displayBounds }, { x: 69, y: 700, width: 1877, height: 1097 }],
	["窗口几乎整个在屏幕外 -> 夹回工作区，保证看得见", { savedBounds: { x: 69, y: 1400, width: 1877, height: 1097 }, windowState: null, workArea, displayBounds }, { x: 69, y: 295, width: 1877, height: 1097 }],
	["窗口比屏幕还大 -> 跟随（主窗口本来就有一部分在屏幕外）", { savedBounds: { x: 0, y: 0, width: 4000, height: 2000 }, windowState: null, workArea, displayBounds }, { x: 0, y: 0, width: 4000, height: 2000 }],
	["没有记录 -> 居中 1280x720", { savedBounds: null, windowState: null, workArea, displayBounds }, { x: 640, y: 336, width: 1280, height: 720 }],
	["全屏但拿不到整屏 -> 退回工作区", { savedBounds: saved, windowState: { fullScreen: true }, workArea, displayBounds: null }, workArea],
	["最大化 + overscan 8 -> 四面各多 8（底边伸到任务栏上方 8px，藏掉 DWM 底边框）", { savedBounds: saved, windowState: { maximized: true }, workArea, displayBounds, overscan: 8 }, { x: -8, y: -8, width: 2576, height: 1408 }],
	["全屏 + overscan 8 -> 四面各多 8（把 DWM 边框和圆角推出屏幕）", { savedBounds: saved, windowState: { fullScreen: true }, workArea, displayBounds, overscan: 8 }, { x: -8, y: -8, width: 2576, height: 1456 }],
	["普通窗口即使给 overscan 也不放大（必须原样跟随）", { savedBounds: saved, windowState: null, workArea, displayBounds, overscan: 8 }, saved]
];
for (const [name, input, expected] of geometry) {
	const actual = computeSplashBounds(input);
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) bad += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${JSON.stringify(actual)}`);
}

// ── 负载不变量 ────────────────────────────────────────────────────────────────
// 这个坑踩过两次：在"窗口还没显示"时调用 maximize() / setFullScreen(true)，Windows 上会把
// 隐藏的主窗口直接显示出来，于是开机动画被主窗口盖掉（表现：动画只播几秒就进软件）。
// 所以 hold() 里绝对不许出现改窗口的调用，恢复动作只能在"即将 show"或"已经 show"时执行。
const payloadSource = readFileSync(new URL("./assets/dsh-boot-splash.js", import.meta.url), "utf8");
const functionBody = (source, name) => {
	const start = source.indexOf(`function ${name}(`);
	if (start < 0) return null;
	let depth = 0;
	let index = source.indexOf("{", start);
	const from = index;
	for (; index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		else if (source[index] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(from, index + 1);
		}
	}
	return null;
};
const holdBody = functionBody(payloadSource, "hold");
const finishBody = functionBody(payloadSource, "finish");
const applyBody = functionBody(payloadSource, "applyPendingWindowState");
const invariants = [
	["hold() 里不调用 maximize/setFullScreen（否则主窗口会提前显形）", holdBody !== null && !/\.(?:maximize|setFullScreen)\(/u.test(holdBody)],
	["hold() 只是登记恢复意图", holdBody !== null && holdBody.includes("planWindowRestore")],
	["applyPendingWindowState() 才是唯一改窗口状态的地方", applyBody !== null && /\.maximize\(|\.setFullScreen\(/u.test(applyBody)],
	["finish() 在 revealNow() 之前应用窗口状态", finishBody !== null && finishBody.includes("applyPendingWindowState") && finishBody.indexOf("applyPendingWindowState") < finishBody.indexOf("revealNow")],
	["诊断记录收尾前的抓拍值", payloadSource.includes("state.mainShownBeforeFinish = state.mainShownAt !== null")],
	["启动窗把 overscan 传进几何计算", payloadSource.includes("overscan: state?.config?.overscan ?? 0")],
	["启动窗尝试关掉 Windows 11 圆角", payloadSource.includes("setRoundedCorners(false)")],
	["启动窗显示后回读 OS 实际给的矩形", payloadSource.includes("splash.setBounds(requestedBounds)")]
];
for (const [name, ok] of invariants) {
	if (!ok) bad += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
}

if (bad > 0) process.exit(1);
console.log("OK");
