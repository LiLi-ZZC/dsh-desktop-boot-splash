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
import { mimeFor, parseRangeHeader, readMainWindowBounds, readSplashConfig, resolveSplashClip } from "./dsh-boot-splash-clip.js";
import { createReadStream, statSync } from "node:fs";
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
	log(`finish (${reason})`);
	const close = () => {
		for (const window of pending) {
			if (alive(window)) revealNow(window);
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
 */
function hold(window) {
	if (state === null || !state.armed || state.finished) return false;
	if (!alive(window)) return true;
	if (!state.pending.includes(window)) state.pending.push(window);
	return true;
}

/** 把保存的 bounds 夹回真实屏幕内，防止窗口落在已拔掉的显示器上。 */
function safeBounds(saved) {
	const displays = screen.getAllDisplays();
	if (saved !== null && displays.some((display) => {
		const area = display.workArea;
		return saved.x < area.x + area.width && saved.x + saved.width > area.x && saved.y < area.y + area.height && saved.y + saved.height > area.y;
	})) return saved;
	const area = screen.getPrimaryDisplay().workArea;
	const width = Math.min(saved === null ? 1280 : saved.width, area.width);
	const height = Math.min(saved === null ? 720 : saved.height, area.height);
	return {
		x: Math.round(area.x + (area.width - width) / 2),
		y: Math.round(area.y + (area.height - height) / 2),
		width,
		height
	};
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
	state = { armed: false, finished: false, pending: [], window: null, timer: null, poller: null };
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
		const bounds = safeBounds(readMainWindowBounds(app.getPath("userData")));
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
			alwaysOnTop: true,
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
		splash.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		splash.webContents.on("will-attach-webview", (event) => {
			event.preventDefault();
		});
		splash.once("ready-to-show", () => {
			if (alive(splash)) splash.show();
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
