window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-mobile",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		// 移动端禁用桌面版 onboarding 向导的自动弹出：
		// 其文案与快捷键教程均为桌面版专属（"DeepSeek Harness Desktop"），且与 dsh 内置
		// onboarding（内测声明 → DeepSeek 配置）同时弹出会冲突，导致欢迎界面被配置界面顶掉。
		// 提前写入 done 标记，仅阻止自动弹出；设置 → 使用教程 仍可通过 force 重跑。
		try { localStorage.setItem("dsh.onboarding.done", "1"); } catch { /* storage unavailable */ }
		//#region dark theme
		// 移动端整体为深色视觉（启动画面 / 原生壳 / 输入法背景均深色），而 dsh 前端默认浅色
		// 主题（body 无 data-ds-dark-theme）。这里强制切换为深色主题，使界面与 App 统一。
		// 前端自身的主题切换逻辑不在此 bundle 内，故设置一次即生效（无需强锁）。
		const applyDarkTheme = () => {
			if (typeof document === "undefined" || document.body === null) return;
			if (!document.body.hasAttribute("data-ds-dark-theme")) {
				document.body.setAttribute("data-ds-dark-theme", "");
			}
		};
		if (typeof document !== "undefined") {
			if (document.readyState === "loading") {
				document.addEventListener("DOMContentLoaded", applyDarkTheme, { once: true });
			} else {
				applyDarkTheme();
			}
		}
		//#endregion
		//#region styles
		// 手机端深度优化：单列会话布局、更大的触摸目标、键盘友好的输入区、拇指友好的滚动。
		// 优先使用未哈希的稳定钩子（data-slot / data-composer-* / data-chat-flow），
		// 具体组件用 [class$="_xxx"] 后缀选择器（哈希前缀随构建变化，后缀稳定）。
		// dsh 前端原生已支持窄屏布局（SIDEBAR_AUTO_COLLAPSE=1024 自动收起侧边栏并可展开，
		// computeColumns 空间不足时自动隐藏详情列），此处不再覆盖 grid，避免锁死侧边栏展开。
		const css = [
			/* ── 全局：字体平滑、去除触屏点击高亮闪现（移出媒体查询，始终生效） ── */
			":root{--dsh-mobile-breakpoint:860px}",
			"[data-slot=root]{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}",
			"[data-slot=root] *{-webkit-tap-highlight-color:transparent}",
			/* 深色主题下根容器背景与状态栏融合 */
			"body[data-ds-dark-theme] [data-slot=root]{background:var(--dsw-alias-bg-base, #0b0e14)}",
			"body[data-ds-dark-theme] [data-slot=conversation]{background:var(--dsw-alias-bg-base, #0b0e14)}",
			/* ── 窄屏适配：布局交给 dsh 原生 auto-collapse，这里只做「耐看」的视觉调优 ── */
			"@media (max-width:860px){",
			"[data-slot=root] [class$=_detailsCol]{overflow:hidden}",
			/* 会话内容全宽 + 舒适留白 */
			"[data-slot=conversation] [class$=_root]{--dsh-chat-content-width:100% !important}",
			"[data-slot=conversation] [class$=_viewArea]{padding-left:16px;padding-right:16px}",
			/* 头部：深色毛玻璃 + 细分隔线（与 App 深色一致，轻盈顶栏） */
			"body[data-ds-dark-theme] [data-slot=conversation] header{padding-top:9px;padding-bottom:9px;background:rgba(11,14,20,0.78);backdrop-filter:saturate(160%) blur(18px);-webkit-backdrop-filter:saturate(160%) blur(18px);border-bottom:1px solid rgba(255,255,255,0.05)}",
			/* 消息流：舒适行高，代码块可横向滑动 */
			"[data-chat-flow]{line-height:1.65}",
			"[data-chat-flow] pre,[data-chat-flow] [class$=_codeBlock]{overflow-x:auto;-webkit-overflow-scrolling:touch}",
			"[data-chat-flow] [class$=_nodeActions]{gap:2px}",
			/* 输入区：深色悬浮圆角胶囊 + 柔和阴影（DeepSeek App 的底部输入条质感） */
			"[data-composer-seat]{--dsh-composer-side-clearance:12px !important;--dsh-composer-dock-inset:10px !important;--dsh-composer-text-max-height:40vh !important}",
			"body[data-ds-dark-theme] [data-composer-card]{border-radius:18px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 30px rgba(0,0,0,0.45),0 1px 3px rgba(0,0,0,0.3)}",
			"[data-composer-card] textarea,[data-input-mirror]{font-size:16px !important;line-height:1.5 !important}",
			"[data-composer-card] [class$=_input]{min-height:46px;padding-top:11px;padding-bottom:11px}",
			/* 触摸目标：会话行 44px+ */
			"[role=treeitem]{min-height:46px;border-radius:10px}",
			"[role=treeitem] [class$=_title]{font-size:14.5px}",
			"[class$=_iconButton]{min-width:44px;min-height:44px}",
			/* 触屏：弱化 hover 残留，增强按压反馈 */
			"[role=treeitem]:hover,[class$=_iconButton]:hover{opacity:1}",
			"[role=treeitem]:active{background:rgba(255,255,255,0.06)}",
			"[class$=_iconButton]:active{transform:scale(0.93);opacity:0.78}",
			/* 滚动条：细、圆润、回弹 */
			"[data-conversation-scroll],[class$=_scroll]{--dsh-scrollbar-width:5px !important;scrollbar-width:thin;overscroll-behavior-y:contain}",
			/* 侧边栏抽屉：深色底、图标圆角 */
			"body[data-ds-dark-theme] [data-slot=sidebar]{background:var(--dsw-specific-sidebar-fill, #151517)}",
			"[data-slot=sidebar] [class$=_iconButton]{border-radius:12px}",
			"[data-slot=sidebar] [class$=_railMark], [data-slot=sidebar] [class$=_panelIcon]{transform:scale(1.12)}",
			/* ── 消息内卡片/表格/图片的窄屏适配 ── */
			"[data-chat-flow] table{display:block;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}",
			"[data-chat-flow] img,[data-chat-flow] video,[data-chat-flow] [class$=_preview]{max-width:100%;height:auto;border-radius:10px}",
			"[data-chat-flow] [class$=_card],article[data-doc]{max-width:100%;box-sizing:border-box}",
			/* 代码块圆角 + 横向滚动提示 */
			"[data-chat-flow] pre{border-radius:12px;font-size:12.5px}",
			/* 设置页：卡片全宽、行距舒适 */
			"[data-slot=settings] [class$=_panel]{padding:14px}",
			"[data-slot=settings] [class$=_row]{min-height:48px}",
			"[data-slot=settings] [class$=_label]{font-size:14px}",
			/* 侧边栏在窄屏展开时底部留白，避开手势区 */
			"[data-slot=sidebar] nav{padding-bottom:20px}",
			/* 会话内容在窄屏的字体微调：正文略大，阅读舒适 */
			"[data-chat-flow] p,[data-chat-flow] li,[data-chat-flow] [class$=_text]{font-size:15px}",
			"[data-chat-flow] h1{font-size:19px}[data-chat-flow] h2{font-size:17px}[data-chat-flow] h3{font-size:15.5px}",
			/* 深色下：对话气泡 / 代码 / 分隔线的柔和层级（跟随主题变量，天然一致） */
			"body[data-ds-dark-theme] [data-chat-flow] [class$=_bubble]{box-shadow:none}",
			"body[data-ds-dark-theme] [data-chat-flow] hr{background:rgba(255,255,255,0.08)}",
			"body[data-ds-dark-theme] [data-chat-flow] blockquote{border-left-color:rgba(255,255,255,0.16)}",
			/* 图片预览遮罩在深色下更沉稳 */
			"body[data-ds-dark-theme] [class$=_mask]{backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}",
			"}"
		].join("");
		const tagId = "@deepseek-ai/dsh-client-ui-mobile/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-mobile";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region runtime
		// 窄屏下隐藏详情列拖拽柄，避免误触（布局仍由 dsh 原生 auto-collapse 控制）。
		const MQ = typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(max-width:860px)") : undefined;
		const applyNarrow = () => {
			if (MQ === undefined || !MQ.matches) return;
			const root = document.querySelector('[data-slot="root"]');
			if (root === null) return;
			const handle = root.querySelector('[class$="_handle"][data-side="details"]');
			if (handle !== null) (handle).style.display = "none";
		};
		let scheduled = false;
		const schedule = () => {
			if (scheduled) return;
			scheduled = true;
			requestAnimationFrame(() => {
				scheduled = false;
				applyNarrow();
			});
		};
		const start = () => {
			if (MQ !== undefined) {
				if (MQ.addEventListener) MQ.addEventListener("change", schedule);
				else MQ.addListener(schedule);
			}
			const observer = new MutationObserver(schedule);
			if (document.body !== null) observer.observe(document.body, { childList: true, subtree: true });
			applyNarrow();
		};
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
		else start();
		//#endregion
		//#region mobile welcome
		// 移动端首次进入的欢迎向导：介绍手机版特色功能（AI 对话 / 手机控制 / 产物保存 / 定时任务），
		// 单页卡片式布局，深色质感 + 优雅动画，一次性展示后不再弹出。
		const WELCOME_KEY = "dsh.mobile.welcome.done.v1";
		const MOBILE_CSS = [
			/* 遮罩：毛玻璃淡入 */
			".dmw-mask{position:fixed;inset:0;z-index:9997;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(8,10,14,.6);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);animation:dmwFade .32s cubic-bezier(.2,.8,.3,1)}",
			"@keyframes dmwFade{from{opacity:0}to{opacity:1}}",
			".dmw-mask.dmw-closing{animation:dmwFadeOut .26s cubic-bezier(.5,0,.8,.4) forwards}",
			"@keyframes dmwFadeOut{to{opacity:0}}",
			".dmw-card{width:min(420px,100%);max-height:88vh;display:flex;flex-direction:column;background:rgba(20,23,31,.94);border:1px solid rgba(255,255,255,.08);border-radius:22px;box-shadow:0 32px 90px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04) inset;overflow:hidden;color:#e6e9f0;font:14px/1.6 system-ui,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;transform-origin:center 34%;animation:dmwCardIn .55s cubic-bezier(.22,1.24,.36,1) backwards}",
			"@keyframes dmwCardIn{from{opacity:0;transform:translateY(28px) scale(.96);filter:blur(5px)}to{opacity:1;transform:none;filter:blur(0)}}",
			".dmw-mask.dmw-closing .dmw-card{animation:dmwCardOut .26s cubic-bezier(.5,0,.8,.4) forwards}",
			"@keyframes dmwCardOut{to{opacity:0;transform:translateY(14px) scale(.975);filter:blur(2px)}}",
			".dmw-head{padding:28px 26px 6px;animation:dmwRise .5s cubic-bezier(.2,.9,.3,1) .1s backwards}",
			"@keyframes dmwRise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}",
			".dmw-brand{display:flex;align-items:center;gap:12px}",
			".dmw-logo{width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,#5a7bff,#3d5af1);display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(77,107,254,.35)}",
			".dmw-logo svg{width:22px;height:22px;color:#fff}",
			".dmw-brand-t{display:flex;flex-direction:column;gap:1px}",
			".dmw-brand-name{font-size:17px;font-weight:700;color:#f0f2f7;letter-spacing:.01em}",
			".dmw-brand-sub{font-size:12px;color:rgba(230,233,240,.5)}",
			".dmw-body{padding:14px 26px 4px;overflow-y:auto;flex:1;scrollbar-width:none}",
			".dmw-body::-webkit-scrollbar{display:none}",
			".dmw-hello{font-size:15px;color:rgba(238,240,245,.92);margin:0 0 4px;animation:dmwRise .5s cubic-bezier(.2,.9,.3,1) .16s backwards}",
			".dmw-desc{font-size:13px;line-height:1.7;color:rgba(230,233,240,.55);margin:0 0 16px;animation:dmwRise .5s cubic-bezier(.2,.9,.3,1) .22s backwards}",
			".dmw-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;animation:dmwRise .5s cubic-bezier(.2,.9,.3,1) .28s backwards}",
			".dmw-tile{border:1px solid rgba(255,255,255,.07);border-radius:14px;background:rgba(255,255,255,.025);padding:13px 13px 12px;transition:transform .18s cubic-bezier(.2,.8,.3,1),background .18s,border-color .18s}",
			".dmw-tile:active{transform:scale(.97);background:rgba(255,255,255,.05)}",
			".dmw-tile svg{width:20px;height:20px;color:rgba(140,160,255,.9);margin-bottom:8px;display:block}",
			".dmw-tile b{display:block;font-size:13.5px;font-weight:600;color:rgba(238,240,245,.94);margin-bottom:3px}",
			".dmw-tile span{font-size:12px;line-height:1.6;color:rgba(230,233,240,.5);display:block}",
			".dmw-foot{display:flex;gap:10px;padding:16px 26px 24px;align-items:center;animation:dmwRise .5s cubic-bezier(.2,.9,.3,1) .34s backwards}",
			".dmw-skip{appearance:none;border:0;background:transparent;color:rgba(230,233,240,.42);font:inherit;font-size:13px;padding:10px 6px;cursor:pointer;transition:color .16s}",
			".dmw-skip:active{color:rgba(230,233,240,.85)}",
			".dmw-start{margin-left:auto;appearance:none;border:0;background:rgba(240,242,247,.96);color:#14161c;font:inherit;font-size:14px;font-weight:600;padding:11px 26px;border-radius:12px;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.3);transition:transform .16s,background .16s}",
			".dmw-start:active{transform:scale(.97);background:#fff}"
		].join("");
		/** 线性图标（stroke，currentColor）——与整体视觉一致，无填充色块。 */
		const ICONS = {
			chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-9 8.35 8.5 8.5 0 0 1-3.7-.8L3 20l1.1-3.3a8.38 8.38 0 1 1 16.9-5.2z"/><path d="M8.5 11.5h7"/><path d="M8.5 15h4"/></svg>',
			phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/><path d="M2.5 9h-1M2.5 15h-1"/><path d="M21.5 9h1M21.5 15h1"/><path d="M12 5.5h.01"/></svg>',
			save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>',
			clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
		};
		const WELCOME_FEATURES = [
			{ icon: "chat", title: "AI 对话", desc: "与桌面版一致的完整 AI 对话与工具调用" },
			{ icon: "phone", title: "手机控制", desc: "开启后 AI 可读取屏幕并操控手机" },
			{ icon: "save", title: "产物保存", desc: "AI 生成的产物可一键保存到手机" },
			{ icon: "clock", title: "定时任务", desc: "定时让 AI 自动执行指定任务" }
		];
		/**
		 * 挂载移动端欢迎向导。仅窄屏（移动端 WebView）且首次进入时展示；
		 * 关闭/开始后写入 localStorage，后续启动不再弹出。
		 */
		const showWelcome = () => {
			if (MQ === undefined || !MQ.matches) return;
			let done = false;
			try { done = localStorage.getItem(WELCOME_KEY) === "1"; } catch { done = true; }
			if (done) return;
			if (document.querySelector("style[data-plugin-css=dmw]") === null) {
				const tag = document.createElement("style");
				tag.dataset.pluginCss = "dmw";
				tag.textContent = MOBILE_CSS;
				document.head.appendChild(tag);
			}
			const mask = document.createElement("div");
			mask.className = "dmw-mask";
			const tiles = WELCOME_FEATURES.map((f) =>
				'<div class="dmw-tile">' + ICONS[f.icon] + "<b>" + f.title + "</b><span>" + f.desc + "</span></div>"
			).join("");
			mask.innerHTML =
				'<div class="dmw-card">' +
				'<div class="dmw-head"><div class="dmw-brand">' +
				'<div class="dmw-logo">' + ICONS.chat + "</div>" +
				'<div class="dmw-brand-t"><span class="dmw-brand-name">DeepSeek Harness</span><span class="dmw-brand-sub">手机版 · 已就绪</span></div></div></div>' +
				'<div class="dmw-body">' +
				'<p class="dmw-hello">欢迎使用</p>' +
				'<p class="dmw-desc">在这里直接向 AI 提问，它可以使用工具完成任务、控制手机、生成并交付产物。以下是手机版的特色能力。</p>' +
				'<div class="dmw-grid">' + tiles + "</div>" +
				'</div>' +
				'<div class="dmw-foot">' +
				'<button type="button" class="dmw-skip">跳过</button>' +
				'<button type="button" class="dmw-start">开始使用</button>' +
				'</div>' +
				"</div>";
			document.body.appendChild(mask);
			const close = () => {
				if (document.body.contains(mask)) {
					mask.classList.add("dmw-closing");
					setTimeout(() => { if (document.body.contains(mask)) mask.remove(); }, 260);
				}
			};
			const doneAll = () => {
				try { localStorage.setItem(WELCOME_KEY, "1"); } catch { /* ignore */ }
				close();
			};
			mask.querySelector(".dmw-start")?.addEventListener("click", doneAll);
			mask.querySelector(".dmw-skip")?.addEventListener("click", doneAll);
		};
		const startWelcome = () => {
			applyDarkTheme();
			showWelcome();
		};
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startWelcome, { once: true });
		else setTimeout(startWelcome, 350);
		//#endregion
		exports.inject = ["locale"];
		exports.apply = function apply() { /* everything is self-wired above */ };
		return module.exports;
	}
});
