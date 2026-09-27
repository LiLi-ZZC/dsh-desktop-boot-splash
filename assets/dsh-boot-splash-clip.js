/**
 * dsh-desktop-boot-splash — 片源解析（纯 Node，不依赖 Electron，方便单独测试）。
 *
 * 解析顺序刻意与 dsh-boot-animation 插件 host 半侧保持一致：
 *   splash.json 的 clip → selection.json 选中的那一条（内置片段或你自己加的片子）
 *   → $DSH_BOOT_ANIMATION → ~/.dsh/boot-animation/intro.mp4
 *   → videos/ 里最新的一个 → 内置 brand 片段
 *
 * 「自己加的片子」那一条靠复刻插件的 makeId() 实现：selection.json 存的是路径派生的
 * id，只有把同样的 id 规则算一遍才能知道用户到底选了哪个文件。早期版本认不出文件 id，
 * 于是退化成「videos 里最新的那个」—— 多放几个片子时就会播错。
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 浏览器能解的概率从高到低；mkv 放最后只是兜底。 */
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".webm", ".mov", ".mkv"]);

/** 与插件一致的 id 前缀：内置片段用 builtin:<name>，文件用路径派生的 makeId。 */
const EMBEDDED_PREFIX = "builtin:";

const DEFAULT_CONFIG = {
	enabled: true,
	maxMs: 15000,
	fit: "cover",
	skippable: true,
	clip: null
};

const MIME_TYPES = new Map([
	[".mp4", "video/mp4"],
	[".m4v", "video/mp4"],
	[".webm", "video/webm"],
	[".mov", "video/quicktime"],
	[".mkv", "video/x-matroska"]
]);

/** 自定义协议用的 MIME；认不出来时按 mp4 报，让浏览器自己嗅探。 */
export function mimeFor(path) {
	return MIME_TYPES.get(extname(path).toLowerCase()) ?? "video/mp4";
}

/**
 * 解析 Range 头。返回 null 表示「整段」，返回 "invalid" 表示该回 416。
 * 浏览器播媒体一定会发 Range，给错状态码有的解码路径会直接拒绝播放。
 */
export function parseRangeHeader(header, size) {
	if (typeof header !== "string" || header.trim() === "") return null;
	const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
	if (match === null) return "invalid";
	const rawStart = match[1];
	const rawEnd = match[2];
	if (rawStart === "" && rawEnd === "") return "invalid";
	if (rawStart === "") {
		const suffix = Number(rawEnd);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(rawStart);
	if (!Number.isSafeInteger(start) || start >= size) return "invalid";
	const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
	if (!Number.isSafeInteger(end) || end < start) return "invalid";
	return { start, end };
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileSize(path) {
	try {
		const info = statSync(path);
		return info.isFile() ? info.size : 0;
	} catch {
		return 0;
	}
}

function isVideoFile(path) {
	return VIDEO_EXTENSIONS.has(extname(path).toLowerCase()) && fileSize(path) > 0;
}

/**
 * 读 JSON，容忍 UTF-8 BOM。
 * Windows 上记事本、以及 PowerShell 的 Set-Content -Encoding UTF8 都会写 BOM，
 * 而 JSON.parse 撞上 BOM 直接抛异常。早先这里静默回退默认值，于是
 * 「我明明改了 splash.json 却没反应」会变成一桩查不出来的悬案。
 */
function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
}

/**
 * DSH 的用户目录：优先 $DSH_HOME，否则 ~/.dsh。
 * 所有路径都必须由它派生 —— 早先 bootAnimationDir() 认 DSH_HOME 而 pluginRoots() 硬用
 * homedir()，DSH_HOME 不在默认位置时会"片源找得到、插件的内置片段找不到"。
 */
export function dshHome() {
	const home = process.env.DSH_HOME?.trim();
	return home !== undefined && home !== "" ? home : join(homedir(), ".dsh");
}

/** ~/.dsh/boot-animation（可用 DSH_BOOT_ANIMATION_DIR 覆盖，主要给测试用）。 */
export function bootAnimationDir() {
	const override = process.env.DSH_BOOT_ANIMATION_DIR?.trim();
	return override !== undefined && override !== "" ? override : join(dshHome(), "boot-animation");
}

/** 插件扫描用户视频的两个目录，顺序与插件的 scanDirs() 一致。 */
function userVideoDirs() {
	const root = bootAnimationDir();
	return [join(root, "videos"), root];
}

/**
 * 复刻插件的 makeId()：FNV-1a（对「小写、反斜杠转正斜杠」的完整路径）+ 文件名前缀。
 * 这段必须和插件保持逐字符一致，否则片库选择就认不出来了。
 */
export function makeLibraryId(path) {
	let h = 0x811c9dc5;
	const normalised = path.replace(/\\/gu, "/").toLowerCase();
	for (let i = 0; i < normalised.length; i += 1) {
		h ^= normalised.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	const stem = basename(path, extname(path)).replace(/[^\w.-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
	return `${stem === "" ? "video" : stem}-${h.toString(16).padStart(8, "0")}`;
}

/** 把 selection.json 里的文件 id 还原成具体文件；认不出来返回 null。 */
function selectedFile(id) {
	for (const dir of userVideoDirs()) {
		let names;
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const full = join(dir, name);
			if (!isVideoFile(full)) continue;
			if (makeLibraryId(full) === id) return { path: full, source: "片库选中的视频", label: full };
		}
	}
	return null;
}

/** 读取并夹紧 splash.json；任何异常都退回默认配置，绝不让启动动画拖垮启动。 */
export function readSplashConfig() {
	let parsed;
	try {
		parsed = readJson(join(bootAnimationDir(), "splash.json"));
	} catch {
		parsed = void 0;
	}
	if (!isRecord(parsed)) parsed = {};
	const config = { ...DEFAULT_CONFIG };
	if (parsed.enabled === false) config.enabled = false;
	if (Number.isSafeInteger(parsed.maxMs) && parsed.maxMs >= 1000 && parsed.maxMs <= 120000) config.maxMs = parsed.maxMs;
	if (parsed.fit === "contain") config.fit = "contain";
	if (parsed.skippable === false) config.skippable = false;
	if (typeof parsed.clip === "string" && parsed.clip.trim() !== "") config.clip = parsed.clip.trim();
	return config;
}

/** 片库面板写下的选择；只用来认 builtin:<name>。 */
function readSelectionId() {
	try {
		const parsed = readJson(join(bootAnimationDir(), "selection.json"));
		return isRecord(parsed) && typeof parsed.id === "string" && parsed.id !== "" ? parsed.id : null;
	} catch {
		return null;
	}
}

/** 所有可能装着 dsh-boot-animation 的 profile 目录。 */
function pluginRoots() {
	const profiles = join(dshHome(), "profiles");
	const roots = [];
	for (const name of ["desktop", "web"]) roots.push(join(profiles, name, "node_modules", "dsh-boot-animation"));
	try {
		for (const entry of readdirSync(profiles)) roots.push(join(profiles, entry, "node_modules", "dsh-boot-animation"));
	} catch {
		// profiles 目录不存在时只保留上面两个候选。
	}
	return [...new Set(roots)];
}

function decodedLength(base64) {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * 从插件自带的 clips.data.js 里抠出某个内置片段。
 * 只用正则取那一段 base64，不 import 12MB 的模块 —— 启动路径上省掉一次整模块解析。
 * 导出是为了能一次性把四段都提取成真实文件（卸载插件前留个底）。
 */
export function resolveBuiltinClip(name) {
	if (!/^[a-z0-9_-]+$/iu.test(name)) return null;
	const pattern = new RegExp(`export const ${name} = "([A-Za-z0-9+/=]+)"`, "u");
	for (const root of pluginRoots()) {
		const dataFile = join(root, "lib", "clips.data.js");
		if (fileSize(dataFile) === 0) continue;
		let text;
		try {
			text = readFileSync(dataFile, "utf8");
		} catch {
			continue;
		}
		const match = pattern.exec(text);
		if (match === null) continue;
		const base64 = match[1];
		const expected = decodedLength(base64);
		const target = join(bootAnimationDir(), ".splash-cache", `${name}-${expected}.mp4`);
		if (fileSize(target) === expected) return { path: target, source: `内置片段 ${name}`, label: name };
		try {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, Buffer.from(base64, "base64"));
		} catch {
			continue;
		}
		return { path: target, source: `内置片段 ${name}`, label: name };
	}
	return null;
}

function fileClip(path, source) {
	return isVideoFile(path) ? { path, source, label: path } : null;
}

function newestVideo(directory) {
	let best = null;
	try {
		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry);
			if (!isVideoFile(path)) continue;
			const at = statSync(path).mtimeMs;
			if (best === null || at > best.at) best = { path, at };
		}
	} catch {
		return null;
	}
	return best === null ? null : { path: best.path, source: "videos 目录里最新的一段", label: best.path };
}

/**
 * 插件自带的默认片头（与模块同目录）。
 * 它的定位是「本插件的默认值」：所有显式选择（前 5 条）都优先于它。
 */
function bundledDefaultClip() {
	try {
		return fileClip(fileURLToPath(new URL("./dsh-boot-splash-default.mp4", import.meta.url)), "插件自带默认片头");
	} catch {
		return null;
	}
}

/** 依次尝试所有来源，返回第一个能用的；全都不可用就返回 null（不播动画，直接进软件）。 */
export function resolveSplashClip(config) {
	const attempts = [];
	if (config.clip !== null) {
		attempts.push(() => (config.clip.startsWith("builtin:") ? resolveBuiltinClip(config.clip.slice(8)) : fileClip(config.clip, "splash.json 指定")));
	}
	const selected = readSelectionId();
	if (selected !== null) {
		attempts.push(() => (selected.startsWith(EMBEDDED_PREFIX) ? resolveBuiltinClip(selected.slice(EMBEDDED_PREFIX.length)) : selectedFile(selected)));
	}
	const env = process.env.DSH_BOOT_ANIMATION?.trim();
	if (env !== undefined && env !== "") attempts.push(() => fileClip(env, "环境变量 DSH_BOOT_ANIMATION"));
	attempts.push(() => fileClip(join(bootAnimationDir(), "intro.mp4"), "intro.mp4"));
	attempts.push(() => newestVideo(join(bootAnimationDir(), "videos")));
	// 本插件的默认值排在另一个插件的隐式兜底之前：
	// dsh-boot-animation 的「没选过就用 brand」是它自己的默认，不该盖掉本插件的默认片头。
	// 用户显式选过的东西在上面 1–5 条里，仍然优先。
	attempts.push(() => bundledDefaultClip());
	attempts.push(() => resolveBuiltinClip("brand"));
	for (const attempt of attempts) {
		try {
			const hit = attempt();
			if (hit !== null && hit !== void 0) return hit;
		} catch {
			// 单个来源坏掉不影响后面的来源。
		}
	}
	return null;
}

/** 复用桌面壳自己持久化的主窗口 bounds，让启动窗和主窗口完全重合。 */
export function readMainWindowBounds(userDataDirectory) {
	try {
		const parsed = readJson(join(userDataDirectory, "main-window-state.json"));
		if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.bounds)) return null;
		const { x, y, width, height } = parsed.bounds;
		if (![x, y, width, height].every((value) => Number.isSafeInteger(value))) return null;
		if (width <= 0 || height <= 0) return null;
		return { x, y, width, height };
	} catch {
		return null;
	}
}
