/**
 * dsh-desktop-boot-splash — DSH 插件（host 半侧）。
 *
 * 它不渲染任何界面：作用是保证 DSH Desktop 的 Electron 壳带着「开机动画」补丁。
 * 为什么这件事必须由插件来做，而不是一次性安装脚本：
 *
 *   DSH Desktop 更新会整体替换 resources/app，补丁随之消失；
 *   而 profile（~/.dsh/profiles/<名字>/node_modules）在用户目录里，更新不碰它。
 *   于是插件每次启动都能自检一次，发现补丁没了就自动补回来 —— 更新后最多损失
 *   一次启动的动画，第二次启动就恢复了。这是「更新后自动运行脚本」最省事也最可靠的形态，
 *   不需要常驻服务、不需要计划任务、不需要管理员权限。
 *
 * 补丁细节见 shell-patch.js。
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { applySplashPatch, cliHints, locateDesktopApp, revertSplashPatch } from "./shell-patch.js";
// 复用负载里的判据，别再写第二份 —— 两边一旦漂移，"卸载后还留着补丁"这种 bug 会很难查。
import { isPluginInstalled } from "../assets/dsh-boot-splash-orphan.js";

export const name = "dsh-desktop-boot-splash";
/** 不需要等任何服务：补丁是文件操作，跟 host 的其它服务没有依赖关系。 */
export const inject = [];

const ASSETS_DIR = fileURLToPath(new URL("../assets/", import.meta.url));
/** 启动后稍微等一下再动手，别跟启动路径抢磁盘。 */
const START_DELAY_MS = 1500;

let ran = false;

/** 当前 profile 目录：优先环境变量，否则按 profile 名拼。 */
function currentProfileDir() {
	const configured = process.env.DSH_PROFILE_DIR?.trim();
	if (configured !== undefined && configured !== "") return configured;
	const profile = process.env.DSH_PROFILE?.trim();
	if (profile === undefined || profile === "") return null;
	const dshHome = process.env.DSH_HOME?.trim();
	const home = dshHome !== undefined && dshHome !== "" ? dshHome : join(homedir(), ".dsh");
	return join(home, "profiles", profile);
}

async function ensurePatch(logger) {
	if (ran) return;
	ran = true;
	try {
		// host 进程里 process.execPath 就是 DSH Desktop.exe；CLI 场景走 hints。
		const app = locateDesktopApp({ execPath: process.execPath, resourcesPath: process.resourcesPath, hints: cliHints() });
		if (app === null) {
			logger.info("dsh-desktop-boot-splash: 当前不是 DSH Desktop 安装（没找到桌面壳），跳过补丁");
			return;
		}
		const profileDir = currentProfileDir();
		const report = applySplashPatch({
			app,
			assetsDir: ASSETS_DIR,
			execPath: process.execPath,
			logger,
			managedBy: "plugin",
			profileDir
		});
		if (report.errors.length === 0 && !report.changed) {
			logger.info(`dsh-desktop-boot-splash: 补丁已在位（app ${report.version}），无需处理`);
		}
	} catch (cause) {
		// 插件绝不能因为打补丁失败而影响 DSH 启动。
		logger.error(`dsh-desktop-boot-splash: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`);
	}
}

/**
 * 插件被卸载时把补丁一起撤掉 —— 这是"快速路径"：卸载通常紧接着重启，
 * 此刻读 profile 的 package.json 就知道依赖已经没了。
 * 正常退出时插件仍在 profile 里，这里什么也不做。
 *
 * 慢速路径在负载里（assets/dsh-boot-splash-orphan.js）：万一这里没跑到
 * （比如卸载时应用是关着的），下次启动由负载自清理，结果一样。
 */
function cleanupIfRemoved(logger) {
	try {
		const profileDir = currentProfileDir();
		if (profileDir === null || isPluginInstalled(profileDir)) return;
		const app = locateDesktopApp({ execPath: process.execPath, resourcesPath: process.resourcesPath, hints: cliHints() });
		if (app === null) return;
		const result = revertSplashPatch({ app });
		if (result.actions.length > 0) logger.info(`dsh-desktop-boot-splash: 插件已卸载，补丁一并移除：${result.actions.join("；")}`);
	} catch (cause) {
		try {
			logger.warn(`dsh-desktop-boot-splash: 卸载清理失败：${cause instanceof Error ? cause.message : String(cause)}`);
		} catch {
			// 忽略。
		}
	}
}

export function apply(ctx) {
	// 整段包 try：apply 抛异常会让这个插件加载失败，进而连累 host 启动。
	// 打补丁失败最多是"没有动画"，绝不能是"DSH 起不来"。
	try {
		ctx.effect(() => {
			const timer = setTimeout(() => {
				void ensurePatch(ctx.logger);
			}, START_DELAY_MS);
			timer.unref?.();
			return () => {
				clearTimeout(timer);
				cleanupIfRemoved(ctx.logger);
			};
		}, "dsh-desktop-boot-splash: 确保桌面壳带着开机动画补丁");
	} catch (cause) {
		try {
			ctx.logger.error(`dsh-desktop-boot-splash: apply 失败：${cause instanceof Error ? cause.message : String(cause)}`);
		} catch {
			// 连日志都不可用就什么也不做。
		}
	}
}
