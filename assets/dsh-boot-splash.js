/**
 * dsh-desktop-boot-splash — 在 DSH Desktop 主窗口出现之前播一段开机动画。
 *
 * 由本仓库的 install.ps1 注入到 resources/app/lib/ 下，并在 main.js 里
 * 于 app.whenReady() 之后调用 startBootSplash()；同时 electron-runtime 的
 * revealApplication() 会先问一次 globalThis.__dshBootSplash.hold()，
 * 于是主窗口的首次显示被推迟到动画播完（或跳过 / 超时）之后。
 *
 * 设计约束（都很要紧，改的时候别丢）：
 *  - 任何异常都只能导致「不播动画、正常进软件」，绝不能让主窗口卡着不出现。
 *  - 总有 maxMs 上限，并且视频报错 / 加载失败 / 卡住都立刻放行。
 *  - 启动窗不存在时 hold() 返回 false，revealApplication 行为与官方完全一致。
 */
import { app, BrowserWindow, protocol, screen } from "electron";
import { detectOrphan, removeShellPatch } from "./dsh-boot-splash-orphan.js";
import { bootAnimationDir, computeSplashBounds, mimeFor, parseRangeHeader, readMainWindowBounds, readSplashConfig, resolveSplashClip } from "./dsh-boot-splash-clip.js";
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB_DIR = fileURLToPath(new URL(".", import.meta.url));
const PAGE = fileURLToPath(new URL("./dsh-boot-splash.html", import.meta.url));
const ACTION_SCHEME = "dsh-boot-splash:";
/** 视频走自定义协议，不依赖 file:// 的本地访问策略。 */
const CLIP_SCHEME = "dsh-boot-clip";
const CLIP_ORIGIN = `${CLIP_SCHEME}://clip/video`;
/** 淡出时长，跟 HTML 里的 transition 对齐。 */
const FADE_MS = 260;
const LOG_PREFIX = "dsh-boot-splash:";
/** 记住主窗口最大化/全屏状态的落点（桌面壳自己只记 restored bounds）。 */
const WINDOW_STATE_FILE = "window-state.json";
/** 每次启动把"这次启动窗实际用了什么几何"落一份，出问题不用猜（主进程日志不一定落到文件）。 */
const SPLASH_DIAGNOSTICS_FILE = "last-splash.json";

// 必须在 app ready 之前登记。
//  - dsh-boot-clip: 之后 protocol.handle 才能把它当标准流式协议用（播视频）
//  - dsh-boot-splash: 只是把回话用的 scheme 占住。不登记的话，页面一旦跳这个协议，
//    Chromium 会把它当外部协议丢给 Windows，弹出「获取打开此链接的应用」。
// 这是模块里唯一的顶层调用：包一层 try 是因为一旦它抛异常，主进程会直接起不来。
try {
	const privileges = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false };
	protocol.registerSchemesAsPrivileged([
		{ scheme: CLIP_SCHEME, privileges: { ...privileges, stream: true } },
		{ scheme: ACTION_SCHEME.slice(0, -1), privileges }
	]);
} catch (error) {
	console.error(`${LOG_PREFIX} registerSchemesAsPrivileged failed: ${error instanceof Error ? error.message : String(error)}`);
}

let state = null;

function log(message) {
	try {
		console.log(`${LOG_PREFIX} ${message}`);
	} catch {
		// 日志失败无所谓。
	}
}

/** 后台/无窗口启动（托盘常驻、--require 之类）时不要弹启动窗。 */
function isBackgroundLaunch(argv) {
	return argv.slice(1).some((argument) => {
		if (argument === "--require" || argument === "--import" || argument === "--expose-internals") return true;
		return argument.startsWith("--require=") || argument.startsWith("--import=");
	});
}

/** 动画结束时自己完成官方 revealApplication 的动作。 */
function revealNow(window) {
	try {
		if (process.platform === "darwin" && app.isHidden()) app.show();
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	} catch (error) {
		log(`reveal failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function alive(window) {
	return window !== null && window !== void 0 && typeof window.isDestroyed === "function" && !window.isDestroyed();
}

/**
 * 「记住窗口的最大化/全屏状态」—— 桌面壳自己只持久化 restored bounds（x/y/宽/高），
 * 不记最大化/全屏，所以每次启动都会退回"未最大化"。这里由插件补上。
 *
 * 存到 ~/.dsh/boot-animation/window-state.json；用窗口事件驱动（maximize/unmaximize/
 * enter-full-screen/leave-full-screen/close）而不是退出钩子 —— 桌面壳有些退出路径走
 * app.exit()，before-quit 不一定触发，而事件一定触发。
 */
function windowStatePath() {
	return join(bootAnimationDir(), WINDOW_STATE_FILE);
}

function readWindowState() {
	try {
		const parsed = JSON.parse(readFileSync(windowStatePath(), "utf8").replace(/^\uFEFF/u, ""));
		return parsed !== null && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function writeWindowState(window) {
	if (!alive(window)) return;
	try {
		mkdirSync(bootAnimationDir(), { recursive: true });
		writeFileSync(windowStatePath(), `${JSON.stringify({
			version: 1,
			maximized: window.isMaximized() === true,
			fullScreen: window.isFullScreen() === true,
			at: new Date().toISOString()
		}, null, 2)}\n`, "utf8");
	} catch (error) {
		log(`window state save failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 只看有没有父窗口：主窗口没有父窗口，对话框通常有，避免把对话框最大化。 */
function isMainWindowLike(window) {
	try {
		return alive(window) && typeof window.getParentWindow === "function" && window.getParentWindow() === null;
	} catch {
		return false;
	}
}

/**
 * 把"记下来的状态"翻译成"这次真正要恢复的状态"。
 * 默认不恢复真全屏：这个壳在 Windows 上没有任何退出全屏的入口（菜单 role 没有加速键、
 * 无边框窗口全屏后按钮也没了），恢复真全屏等于把用户困住 —— 所以退化成最大化，仍然可退出。
 */
function effectiveWindowState(saved, config) {
	if (saved === null || saved.fullScreen !== true) return saved;
	if (config?.restoreFullScreen === true) return saved;
	return { ...saved, fullScreen: false, maximized: true, degradedFromFullScreen: true };
}

/**
 * 只**登记意图**，绝不动窗口。
 *
 * 踩过的坑：`maximize()` 和 `setFullScreen(true)` 在"窗口还没显示"时调用，Windows 上都会
 * 把隐藏的主窗口直接显示出来 —— 于是开机动画被主窗口盖掉（表现：动画只播几秒就进软件）。
 * 所以恢复动作一律推迟到"即将 show() 的同一拍"（见 applyPendingWindowState）。
 */
function planWindowRestore() {
	const saved = effectiveWindowState(readWindowState(), state?.config ?? null);
	if (state !== null) {
		state.pendingRestore = saved;
		// 立刻把"恢复意图"记下来：诊断文件是在恢复动作之前写的，
		// 不在这里记的话，明明恢复了也会显示成 null。
		if (state.restoredKind === null || state.restoredKind === void 0) {
			state.restoredKind = saved === null ? null : saved.fullScreen === true ? "fullscreen(pending)" : saved.maximized === true ? "maximized(pending)" : null;
		}
	}
	return saved;
}

/** 真正执行恢复：只在"马上要 show()"或"窗口已经被显示"时调用。 */
function applyPendingWindowState(window) {
	const pending = state?.pendingRestore ?? null;
	if (pending === null || pending === void 0 || !alive(window)) return null;
	try {
		if (pending.fullScreen === true) {
			if (window.isFullScreen() !== true) {
				window.setFullScreen(true);
				if (state !== null) state.restoredKind = "fullscreen";
				log("window state restored (fullscreen)");
			}
		} else if (pending.maximized === true && window.isMaximized() !== true) {
			window.maximize();
			if (state !== null) state.restoredKind = pending.degradedFromFullScreen === true ? "maximized (fullscreen 降级)" : "maximized";
			log(`window state restored (${state?.restoredKind ?? "maximized"})`);
		}
	} catch (error) {
		log(`window state restore failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return window;
}

/** 订阅一次就够了：窗口的每次状态变化都落盘，崩溃/强杀也不会丢。 */
function trackWindowState(window) {
	if (!isMainWindowLike(window) || state === null || state.tracked === true) return;
	state.tracked = true;
	state.mainWindow = window;
	const save = () => writeWindowState(window);
	for (const event of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "close"]) {
		try {
			window.on(event, save);
		} catch {
			// 事件挂不上就算了，不影响启动。
		}
	}
	// 安全阀：壳自己没有退出全屏的入口（无边框窗口全屏后菜单和按钮都没了），
	// 所以只要窗口进了全屏，就顺手给 F11 挂一个切换，免得用户被困住。
	const bindFullScreenEscape = () => {
		try {
			window.webContents.on("before-input-event", (event, input) => {
				if (input.type !== "keyDown" || input.key !== "F11") return;
				event.preventDefault();
				try {
					window.setFullScreen(window.isFullScreen() !== true);
				} catch {
					// 切换失败就算了，不影响别的。
				}
			});
		} catch {
			// webContents 不可用时忽略。
		}
	};
	try {
		if (window.isFullScreen() === true) bindFullScreenEscape();
		else window.on("enter-full-screen", bindFullScreenEscape);
	} catch {
		// 挂不上就算了。
	}
	// 探针：主窗口如果在启动窗结束之前就被显示出来，说明有东西绕过了 hold
	// （曾经就是 setFullScreen 在隐藏窗口上把主窗口弄显形，动画只播几秒）。
	try {
		window.once("show", () => {
			if (state !== null && state.mainShownAt === null) state.mainShownAt = new Date().toISOString();
		});
	} catch {
		// 同上。
	}
}

/** 启动窗结束：先把被拦住的窗口显示出来，再拆掉自己，避免中间闪一下桌面。 */
function finish(reason) {
	if (state === null || state.finished) return;
	state.finished = true;
	if (state.timer !== null) clearTimeout(state.timer);
	state.timer = null;
	if (state.poller !== null) clearInterval(state.poller);
	state.poller = null;
	const splash = state.window;
	state.window = null;
	const pending = state.pending;
	state.pending = [];
	// 抓拍：在"我们开始收尾"这一刻，主窗口有没有已经自己露过脸（=有东西绕过了 hold）。
	state.mainShownBeforeFinish = state.mainShownAt !== null;
	log(`finish (${reason})`);
	noteSplashFinish(reason);
	const close = () => {
		for (const window of pending) {
			if (!alive(window)) continue;
			// 恢复窗口状态必须和 show() 同一拍：早了会把隐藏的主窗口弄显形（动画被盖掉），
			// 晚了会先闪一下未恢复的窗口态。once("show") 只是"启动窗被关掉"时的兜底。
			if (isMainWindowLike(window)) applyPendingWindowState(window);
			revealNow(window);
		}
		if (alive(splash)) splash.destroy();
	};
	if (alive(splash)) {
		splash.webContents.executeJavaScript('document.documentElement.classList.add("dsh-splash-done")', true).catch(() => {});
		setTimeout(close, FADE_MS);
	} else {
		close();
	}
}

/**
 * 兜底的导航拦截：正常路径下页面根本不跳协议（它只写全局变量），
 * 这条只在页面出了意外、真的去导航时才用得上，避免请求漏到操作系统。
 */
function parseAction(href) {
	let url;
	try {
		url = new URL(href);
	} catch {
		return void 0;
	}
	if (url.protocol !== ACTION_SCHEME) return void 0;
	// 特权协议会被规范化成 dsh-boot-splash://done/...，非特权则是 dsh-boot-splash:done，
	// 所以两处都认。
	const kind = url.hostname !== "" ? url.hostname : url.pathname.replace(/^\/+/u, "").split("/")[0];
	return kind === "done" || kind === "fail" ? `${kind}:${url.searchParams.get("reason") ?? "unknown"}` : void 0;
}

/**
 * 页面回话的通道：轮询读取。
 * 不用 navigation / IPC，是因为前者会被 Chromium 当成外部协议交给 Windows
 * （弹「获取打开此链接的应用」，而且主进程收不到任何通知）。
 * 两条通道都查：document.title（同步、不受 JS 世界隔离影响）+ 全局变量。
 */
function startStatePolling(splash) {
	return setInterval(() => {
		if (state === null || state.finished || !alive(splash)) return;
		try {
			const title = splash.getTitle();
			const reported = typeof title === "string" && (title.startsWith(`${LOG_PREFIX}done:`) || title.startsWith(`${LOG_PREFIX}fail:`));
			if (reported) {
				finish(`title:${title.slice(LOG_PREFIX.length)}`);
				return;
			}
		} catch {
			// 窗口正在销毁时 getTitle 可能抛异常，忽略即可。
		}
		splash.webContents.executeJavaScript("window.__dshSplashState ?? null", true)
			.then((value) => {
				if (typeof value === "string" && value !== "") finish(`page:${value}`);
			})
			.catch(() => {});
	}, 200);
}

/**
 * 被 electron-runtime 的 revealApplication() 调用：true = 这次先别显示。
 * 只拦第一次显示；启动窗已经结束时一律放行。多个窗口被拦时全部记下来，结束时一起放行。
 *
 * 这里同时是"恢复上次最大化/全屏"的最佳切入点：它正好发生在窗口 show() 之前，
 * 而且**和启动窗开不开无关** —— enabled:false 时我们只是不拦（返回 false），
 * 窗口状态的记忆/恢复照旧生效。
 */
/**
 * 被 electron-runtime 的 revealApplication() 调用：true = 这次先别显示。
 * 只拦第一次显示；启动窗已经结束时一律放行。多个窗口被拦时全部记下来，结束时一起放行。
 *
 * 窗口状态的记忆/恢复挂在这里，而且**和启动窗的生死无关**，所以它必须排在
 * 任何"提前返回"之前 —— 慢机器上宿主启动可能比片头还久（实测有 host-boot 9.4 秒、
 * 主窗口 11.7 秒才 reveal 的），那时 state.finished 早已是 true，一旦提前返回，
 * 「记录」和「恢复」两侧就一起失效了（这正是 v1.2.0 的一个真实 bug）。
 *
 * 注意这里绝对不能动窗口 —— 见 planWindowRestore() 的注释。
 */
function hold(window) {
	if (state === null) return false;
	if (state.config !== null && state.config.rememberWindowState !== false && isMainWindowLike(window)) {
		trackWindowState(window);
		if (state.restored !== true) {
			state.restored = true;
			planWindowRestore();
			// 兜底：没被拦（启动窗已结束 / enabled:false）时，等壳自己 show 的那一刻再恢复。
			try {
				window.once("show", () => {
					if (state?.pendingRestore !== null && state?.pendingRestore !== void 0) applyPendingWindowState(window);
				});
			} catch {
				// 挂不上就算了。
			}
			// 启动窗已经结束了才登记 —— 说明是"晚到的 reveal"，单独记一笔便于排查。
			if (state.finished) noteWindowStateRegistration();
		}
	}
	if (state.finished) return false;
	if (!alive(window)) return state.armed;
	if (!state.armed) return false;
	if (!state.pending.includes(window)) state.pending.push(window);
	return true;
}

/**
 * 启动窗的几何：和主窗口"马上会变成的样子"对齐。
 * 只按还原尺寸摆的话，主窗口这次要是最大化/全屏，动画就只占中间一块；
 * 而窗口被拖到屏幕外沿时，又必须原样跟随（否则动画会跑到窗口之外）。
 */
function safeBounds(saved, windowState) {
	const anchor = saved ?? screen.getPrimaryDisplay().workArea;
	const display = screen.getDisplayMatching(anchor);
	const bounds = computeSplashBounds({
		savedBounds: saved,
		windowState,
		workArea: display.workArea,
		displayBounds: display.bounds,
		overscan: state?.config?.overscan ?? 0
	});
	if (saved !== null && (bounds.x !== saved.x || bounds.y !== saved.y || bounds.width !== saved.width || bounds.height !== saved.height)) {
		log(`splash bounds adjusted for ${windowState?.fullScreen === true ? "fullscreen" : windowState?.maximized === true ? "maximized" : "off-screen"} window`);
	}
	return bounds;
}

/**
 * 落一份"这次启动窗到底用了什么几何"。
 * 主进程的 console 输出不一定会进桌面壳的日志文件，所以关键信息单独写一份 JSON，
 * 出问题直接看 ~/.dsh/boot-animation/last-splash.json 就行。
 */
function writeSplashDiagnostics({ windowState, savedBounds, bounds, topMost, clipBytes }) {
	try {
		const display = screen.getDisplayMatching(bounds);
		mkdirSync(bootAnimationDir(), { recursive: true });
		writeFileSync(join(bootAnimationDir(), SPLASH_DIAGNOSTICS_FILE), `${JSON.stringify({
			version: 1,
			at: new Date().toISOString(),
			windowState,
			mainWindowBounds: savedBounds,
			splashBounds: bounds,
			alwaysOnTop: topMost,
			workArea: display.workArea,
			displayBounds: display.bounds,
			scaleFactor: display.scaleFactor,
			clipBytes
		}, null, 2)}\n`, "utf8");
	} catch (error) {
		log(`diagnostics write failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 记账结束原因（页面报的、超时、退出……），方便回头看"这次动画是怎么结束的"。 */
function noteSplashFinish(reason) {
	try {
		const path = join(bootAnimationDir(), SPLASH_DIAGNOSTICS_FILE);
		const current = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
		writeFileSync(path, `${JSON.stringify({
			...current,
			finishedAt: new Date().toISOString(),
			startedAt: state?.startedAt ?? null,
			mainWindowShownAt: state?.mainShownAt ?? null,
			mainWindowShownBeforeFinish: state?.mainShownBeforeFinish === true,
			finishReason: reason,
			restoredWindowState: state?.restoredKind ?? null,
			pendingRestore: state?.pendingRestore ?? null,
			splashBoundsRequested: state?.splashBoundsRequested ?? null,
			splashBoundsActual: state?.splashBoundsActual ?? null
		}, null, 2)}\n`, "utf8");
	} catch {
		// 诊断文件不存在或写不进去都不该影响启动。
	}
}

/**
 * 留痕：窗口状态是在**启动窗结束之后**才登记的（"晚到的 reveal"）。
 * 慢机器上宿主启动可能比片头更久（实测有 host-boot 9.4 秒、主窗口 11.7 秒才 reveal 的），
 * 那属于正常路径；看到这两个字段就说明该机器是这种情况，也便于确认这个 bug 已修复。
 */
function noteWindowStateRegistration() {
	try {
		const path = join(bootAnimationDir(), SPLASH_DIAGNOSTICS_FILE);
		const current = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
		writeFileSync(path, `${JSON.stringify({
			...current,
			windowStateRegisteredAt: new Date().toISOString(),
			windowStateRegisteredAfterFinish: true,
			pendingRestore: state?.pendingRestore ?? null
		}, null, 2)}\n`, "utf8");
	} catch {
		// 诊断文件不存在或写不进去都不该影响启动。
	}
}

/** 自定义协议的回话：支持 Range，浏览器播媒体一定会用到。 */
function serveClip(clipPath, request) {
	const size = statSync(clipPath).size;
	const type = mimeFor(clipPath);
	const range = parseRangeHeader(request.headers.get("range") ?? "", size);
	if (range === "invalid") {
		return new Response("range not satisfiable", { status: 416, headers: { "content-range": `bytes */${String(size)}` } });
	}
	if (range === null) {
		return new Response(Readable.toWeb(createReadStream(clipPath)), {
			status: 200,
			headers: {
				"content-type": type,
				"content-length": String(size),
				"accept-ranges": "bytes",
				"cache-control": "no-store"
			}
		});
	}
	return new Response(Readable.toWeb(createReadStream(clipPath, { start: range.start, end: range.end })), {
		status: 206,
		headers: {
			"content-type": type,
			"content-length": String(range.end - range.start + 1),
			"content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
			"accept-ranges": "bytes",
			"cache-control": "no-store"
		}
	});
}

/** main.js 在 app.whenReady() 之后立刻调用；同步建窗，保证第一个 reveal 一定被拦住。 */
export function startBootSplash() {
	if (state !== null) return;
	state = {
		armed: false,
		finished: false,
		pending: [],
		window: null,
		timer: null,
		poller: null,
		config: null,
		tracked: false,
		restored: false,
		restoredKind: null,
		mainWindow: null,
		pendingRestore: null,
		mainShownAt: null,
		mainShownBeforeFinish: false,
		splashBoundsRequested: null,
		splashBoundsActual: null,
		startedAt: null
	};
	globalThis.__dshBootSplash = { hold };
	try {
		// 先看这份补丁还是不是"有主的"：如果插件已经从 profile 里消失，就把补丁整个撤掉，
		// 这一次也不播动画 —— 卸载插件 = 连开机动画一起拿掉。
		// 放在最前面（早于读配置/开窗口），所以卸载后的第一次启动就已经是干净的了。
		const orphan = detectOrphan(LIB_DIR);
		if (orphan !== null) {
			const result = removeShellPatch(LIB_DIR, log);
			log(`插件已从 ${orphan.profileDir} 卸载，补丁已自动移除：${result.actions.join("；")}`);
			return;
		}
		const config = readSplashConfig();
		state.config = config;
		if (!config.enabled) {
			log("disabled by splash.json");
			return;
		}
		if (isBackgroundLaunch(process.argv)) {
			log("background launch, no splash");
			return;
		}
		const clip = resolveSplashClip(config);
		if (clip === null) {
			log("no clip resolved, no splash");
			return;
		}
		const rawWindowState = readWindowState();
		const windowState = effectiveWindowState(rawWindowState, config);
		const savedBounds = readMainWindowBounds(app.getPath("userData"));
		const bounds = safeBounds(savedBounds, windowState);
		// 只有"真全屏"才置顶：否则启动窗会压过任务栏 —— 普通窗口压在任务栏区域时
		// 任务栏本来就在上面（主窗口就是这个行为），置顶反而会盖住它。
		const topMost = windowState?.fullScreen === true;
		state.startedAt = new Date().toISOString();
		writeSplashDiagnostics({ windowState: rawWindowState, effectiveWindowState: windowState, savedBounds, bounds, topMost, clipPath: clip.path ?? null });
		const splash = new BrowserWindow({
			...bounds,
			show: false,
			frame: false,
			transparent: false,
			backgroundColor: "#000000",
			hasShadow: false,
			resizable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			alwaysOnTop: topMost,
			autoHideMenuBar: true,
			title: "DSH Desktop",
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				nodeIntegrationInSubFrames: false,
				sandbox: true,
				webviewTag: false,
				spellcheck: false,
				partition: "dsh-boot-splash"
			}
		});
		state.window = splash;
		state.armed = true;
		try {
			protocol.handle(CLIP_SCHEME, (request) => serveClip(clip.path, request));
		} catch (error) {
			// 协议已被登记过（例如重启宿主）时忽略，页面还有 file:// 回退。
			log(`protocol handler: ${error instanceof Error ? error.message : String(error)}`);
		}
		log(`playing ${clip.source} -> ${clip.path} (${config.fit}, max ${config.maxMs}ms)`);
		splash.removeMenu();
		splash.setMenuBarVisibility(false);
		// Windows 11 会给窗口加圆角、画一条 DWM 亮边框：启动窗铺到屏幕边缘时，这两样会露出来
		// （顶部的亮线、左上角漏出的桌面）。圆角能关就关，关不掉就靠 overscan 推出屏幕。
		try {
			if (typeof splash.setRoundedCorners === "function") splash.setRoundedCorners(false);
		} catch {
			// 忽略：不影响启动。
		}
		splash.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		splash.webContents.on("will-attach-webview", (event) => {
			event.preventDefault();
		});
		const requestedBounds = { ...bounds };
		splash.once("ready-to-show", () => {
			if (!alive(splash)) return;
			splash.show();
			// Windows 有时会把窗口"夹"回屏幕内（尺寸或位置被改），这里回读实际值：
			// 不一致就再设一次，并把最终值记进诊断 —— 这样"露边"这类问题不用猜。
			try {
				splash.setBounds(requestedBounds);
				const actual = splash.getBounds();
				state.splashBoundsRequested = requestedBounds;
				state.splashBoundsActual = actual;
				if (actual.x !== requestedBounds.x || actual.y !== requestedBounds.y || actual.width !== requestedBounds.width || actual.height !== requestedBounds.height) {
					log(`splash bounds adjusted by OS: requested ${JSON.stringify(requestedBounds)} got ${JSON.stringify(actual)}`);
				}
			} catch (error) {
				log(`splash bounds read-back failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
		splash.on("closed", () => finish("window-closed"));
		state.poller = startStatePolling(splash);
		const navigate = (event, href) => {
			const action = parseAction(href);
			if (action === void 0) return;
			event.preventDefault();
			finish(action);
		};
		splash.webContents.on("will-navigate", navigate);
		splash.webContents.on("will-redirect", navigate);
		splash.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
			if (isMainFrame !== false) finish(`load-failed:${code}:${description}`);
		});
		splash.webContents.on("render-process-gone", () => finish("renderer-gone"));
		state.timer = setTimeout(() => finish("timeout"), config.maxMs);
		// 带真实扩展名，个别解码路径会看后缀挑容器；实际字节由协议处理器给。
		const extension = clip.path.slice(clip.path.lastIndexOf(".")).toLowerCase();
		splash.loadFile(PAGE, {
			query: {
				src: `${CLIP_ORIGIN}${extension}`,
				fallback: pathToFileURL(clip.path).href,
				fit: config.fit,
				skippable: config.skippable ? "1" : "0"
			}
		}).catch((error) => finish(`load-error:${error instanceof Error ? error.message : String(error)}`));
		app.once("before-quit", () => finish("app-quit"));
	} catch (error) {
		log(`startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		state.armed = false;
		state.finished = true;
	}
}
