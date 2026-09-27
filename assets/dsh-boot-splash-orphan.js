/**
 * 「孤儿补丁」自清理 —— 卸载插件就该连开机动画一起拿掉。
 *
 * 为什么这段必须住在负载里（而不是插件的 lib/ 里）：
 *   插件一旦被卸载就不会再运行了，任何写在插件里的清理代码都不会被调用。
 *   而这份负载是被 Electron 主进程的 main.js import 的，每次启动必定执行一次，
 *   所以只有它能在"插件已经不在"的情况下把补丁撤干净。
 *
 * 判定规则（务必保守）：
 *   - 只有 managedBy === "plugin" 的补丁才会自我清理；install.ps1 装的（"script"）
 *     由那个脚本自己管，这里绝不越权。
 *   - 状态文件里没记下 profileDir 就不动手（宁可留着补丁，也不能删错东西）。
 *   - profile 里"依赖"或"bundles"任一提及本插件，就认为插件还在。
 *
 * 撤销顺序很要紧：先摘 main.js 的 import，再摘 runtime 的拦截，最后才删负载文件。
 * 反过来的话，中途失败会留下"main.js 还 import 着一个已被删掉的文件"，主进程直接起不来。
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const PLUGIN_PACKAGE = "dsh-desktop-boot-splash";
export const STATE_FILE = "dsh-boot-splash-state.json";
export const BACKUP_SUFFIX = ".dsh-boot-splash.bak";
export const MARKER = "__dshBootSplash";

/** 部署进 resources/app/lib 的负载文件（含本文件自己）。 */
export const PAYLOAD_FILES = [
	"dsh-boot-splash.js",
	"dsh-boot-splash-clip.js",
	"dsh-boot-splash-orphan.js",
	"dsh-boot-splash.html",
	"dsh-boot-splash-default.mp4"
];

const MAIN_IMPORT = 'import { startBootSplash } from "./dsh-boot-splash.js";';
const MAIN_CALL = "\t\tstartBootSplash();";
const RUNTIME_HOLD = `\tif (globalThis.${MARKER}?.hold?.(window) === true) return;`;

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
	} catch {
		return null;
	}
}

function readText(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function writeText(path, text) {
	writeFileSync(path, text, "utf8");
}

/** 插件是否还装在这个 profile 里：依赖或 bundles 任一提及即算在。 */
export function isPluginInstalled(profileDir) {
	const pkg = readJson(join(profileDir, "package.json"));
	if (pkg === null || typeof pkg !== "object") return false;
	const dependencies = pkg.dependencies;
	const inDependencies = typeof dependencies === "object" && dependencies !== null && PLUGIN_PACKAGE in dependencies;
	const bundles = pkg.dsh?.profile?.bundles;
	const inBundles = Array.isArray(bundles) && bundles.includes(PLUGIN_PACKAGE);
	return inDependencies || inBundles;
}

/** 读补丁归属记录（由 applySplashPatch 写入）。 */
export function readOwnership(libDir) {
	return readJson(join(libDir, STATE_FILE));
}

/**
 * 这份补丁是不是已经成了孤儿。返回 null 表示不用管。
 * @returns {{ profileDir: string, appVersion: string } | null}
 */
export function detectOrphan(libDir) {
	const state = readOwnership(libDir);
	if (state === null || state.managedBy !== "plugin") return null;
	const profileDir = typeof state.profileDir === "string" ? state.profileDir.trim() : "";
	if (profileDir === "") return null;
	if (isPluginInstalled(profileDir)) return null;
	return { profileDir, appVersion: typeof state.appVersion === "string" ? state.appVersion : "unknown" };
}

/** 去掉一处注入；返回 [新内容, 是否改动了]。 */
function stripInjection(text, fragment) {
	const at = text.indexOf(fragment);
	if (at < 0) return [text, false];
	// 我们的注入都是"换行 + 片段"的形式，所以连前面那个换行一起摘掉才能还原官方原字节
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const start = at >= newline.length && text.slice(at - newline.length, at) === newline ? at - newline.length : at;
	return [text.slice(0, start) + text.slice(at + fragment.length), true];
}

/**
 * 把补丁从桌面壳上撤掉：摘注入 + 删负载文件 + 删状态文件。
 * 结果与官方原文件逐字节一致（注入是精确字符串，去掉就是原样）。
 */
export function removeShellPatch(libDir, log = () => {}) {
	const actions = [];
	const errors = [];
	const runtime = (() => {
		try {
			const hit = readdirSync(libDir).filter((name) => /^electron-runtime-.*\.js$/u.test(name)).sort();
			return hit.length === 0 ? null : join(libDir, hit[0]);
		} catch {
			return null;
		}
	})();

	// 1) main.js —— 必须最先摘，否则可能留下"import 一个已被删掉的文件"
	const mainJs = join(libDir, "main.js");
	let mainText = readText(mainJs);
	if (mainText !== null) {
		for (const fragment of [MAIN_IMPORT, MAIN_CALL]) {
			const [next, changed] = stripInjection(mainText, fragment);
			if (changed) mainText = next;
		}
		if (!mainText.includes("startBootSplash")) {
			writeText(mainJs, mainText);
			actions.push("还原 main.js");
		} else {
			// 意想不到的结构：退回官方备份（如果有），别硬删
			const backup = `${mainJs}${BACKUP_SUFFIX}`;
			if (existsSync(backup)) {
				copyFileSync(backup, mainJs);
				actions.push("从备份还原 main.js");
			} else {
				errors.push("main.js 里仍有补丁痕迹，但没有备份可还原");
			}
		}
	}

	// 2) electron-runtime —— 摘掉 revealApplication 的拦截
	if (runtime !== null) {
		const text = readText(runtime);
		if (text !== null && text.includes(MARKER)) {
			const [next, changed] = stripInjection(text, RUNTIME_HOLD);
			if (changed && !next.includes(MARKER)) {
				writeText(runtime, next);
				actions.push(`还原 ${basename(runtime)}`);
			} else {
				const backup = `${runtime}${BACKUP_SUFFIX}`;
				if (existsSync(backup)) {
					copyFileSync(backup, runtime);
					actions.push(`从备份还原 ${basename(runtime)}`);
				} else {
					errors.push(`${basename(runtime)} 里仍有补丁痕迹，但没有备份可还原`);
				}
			}
		}
	}

	// 3) 备份与负载文件最后删 —— 上面两步失败时它们还有用
	for (const name of readdirSync(libDir)) {
		if (!name.endsWith(BACKUP_SUFFIX)) continue;
		try {
			unlinkSync(join(libDir, name));
			actions.push(`删除 ${name}`);
		} catch (cause) {
			errors.push(`删不掉 ${name}：${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}
	for (const name of [...PAYLOAD_FILES, STATE_FILE]) {
		const target = join(libDir, name);
		if (!existsSync(target)) continue;
		try {
			unlinkSync(target);
			actions.push(`删除 ${name}`);
		} catch (cause) {
			errors.push(`删不掉 ${name}：${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}

	for (const error of errors) log(`误差：${error}`);
	return { actions, errors };
}
