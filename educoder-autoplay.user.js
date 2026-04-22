// ==UserScript==
// @name         头歌 EduCoder 视频自动播放 / 刷课
// @namespace    https://github.com/
// @version      3.4.0
// @description  自动播放头歌视频，结束后 new_video_id+1 切换下一节，可手动上/下
// @match        *://www.educoder.net/*
// @match        *://*.educoder.net/*
// @run-at       document-start
// @all-frames   true
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STORE_KEY = 'tg_autoplay_config';
    const DEFAULTS = { rate: 3, muted: true, autoNext: true };
    const CONFIG = Object.assign({}, DEFAULTS, (() => {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
        catch { return {}; }
    })());
    function saveConfig() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(CONFIG)); } catch {}
    }
    const PARAM = 'new_video_id';

    // ====== 绕过后台暂停 ======
    try {
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        ['visibilitychange', 'webkitvisibilitychange', 'blur'].forEach(ev => {
            window.addEventListener(ev, e => e.stopImmediatePropagation(), true);
        });
    } catch {}

    // ====== URL 切换：id ± 1 ======
    function urlId() {
        const v = new URLSearchParams(location.search).get(PARAM);
        return v ? parseInt(v, 10) : null;
    }

    // 记录"最后一次真正选中的" id：
    // - 页面加载时从 URL 取
    // - 用户点击任何带 new_video_id 的链接/元素时更新
    // - 脚本自己跳转时（gotoDelta）也会更新
    let lastKnownId = urlId();

    function extractIdFromEl(el) {
        while (el && el !== document.body) {
            // 1) <a href=...?new_video_id=X>
            if (el.tagName === 'A' && el.href) {
                try {
                    const id = parseInt(new URL(el.href, location.href).searchParams.get(PARAM), 10);
                    if (!isNaN(id)) return id;
                } catch {}
            }
            // 2) data-new_video_id / data-video-id 等
            if (el.dataset) {
                for (const k of Object.keys(el.dataset)) {
                    if (/video[_-]?id/i.test(k)) {
                        const id = parseInt(el.dataset[k], 10);
                        if (!isNaN(id)) return id;
                    }
                }
            }
            el = el.parentElement;
        }
        return null;
    }

    // 捕获阶段拦截所有 click，看是否是列表项
    document.addEventListener('click', e => {
        const id = extractIdFromEl(e.target);
        if (id != null) {
            console.log('[AutoPlay] 检测到点击列表项 id=' + id);
            lastKnownId = id;
        }
    }, true);

    // XHR / fetch 嗅探：API 请求里通常带 video_id，也能推断"最新"的那个
    function sniffUrl(u) {
        try {
            const m = String(u).match(/(?:new_video_id|video_id)=(\d+)/);
            if (m) {
                const id = parseInt(m[1], 10);
                if (!isNaN(id)) {
                    lastKnownId = id;
                    console.log('[AutoPlay] 从请求嗅探到 id=' + id);
                }
            }
        } catch {}
    }
    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        sniffUrl(url);
        return _open.call(this, method, url, ...rest);
    };
    const _fetch = window.fetch;
    window.fetch = function (input, init) {
        sniffUrl(typeof input === 'string' ? input : input?.url);
        return _fetch.apply(this, arguments);
    };

    function currentId() { return lastKnownId ?? urlId(); }

    function gotoDelta(delta) {
        const id = currentId();
        if (id == null || isNaN(id)) {
            console.warn('[AutoPlay] 找不到当前 video id');
            return;
        }
        const url = new URL(location.href);
        url.searchParams.set(PARAM, String(id + delta));
        console.log(`[AutoPlay] 跳转 id=${id} → ${id + delta}`);
        location.href = url.href;
    }
    const gotoNext = () => gotoDelta(+1);
    const gotoPrev = () => gotoDelta(-1);

    // ====== 视频接管 ======
    const handled = new WeakSet();

    function deepQuery(root, tag) {
        const out = [];
        if (!root) return out;
        if (root.querySelectorAll) root.querySelectorAll(tag).forEach(n => out.push(n));
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let n = walker.currentNode;
        while (n) {
            if (n.shadowRoot) out.push(...deepQuery(n.shadowRoot, tag));
            n = walker.nextNode();
        }
        return out;
    }

    function hookVideo(video) {
        if (handled.has(video)) return;
        handled.add(video);
        console.log('[AutoPlay] 接管视频元素', video);

        video.muted = CONFIG.muted;
        video.autoplay = true;

        const apply = () => {
            if (video.paused) video.play().catch(() => {});
            if (Math.abs(video.playbackRate - CONFIG.rate) > 0.01) video.playbackRate = CONFIG.rate;
        };

        video.addEventListener('loadedmetadata', apply);
        video.addEventListener('canplay', apply);
        video.addEventListener('pause', () => setTimeout(apply, 200));
        video.addEventListener('ratechange', apply);

        let firedNext = false;
        const fireNext = () => {
            if (firedNext || !CONFIG.autoNext) return;
            firedNext = true;
            console.log('[AutoPlay] 视频播完，准备跳下一节');
            setTimeout(gotoNext, 500);
        };
        video.addEventListener('ended', fireNext);
        video.addEventListener('timeupdate', () => {
            if (video.duration && video.duration - video.currentTime < 0.5) fireNext();
        });

        apply();
    }

    function scanVideos() { deepQuery(document, 'video').forEach(hookVideo); }

    // 劫持 attachShadow
    const _attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
        const sr = _attach.call(this, init);
        try {
            new MutationObserver(scanVideos).observe(sr, { childList: true, subtree: true });
            scanVideos();
        } catch {}
        return sr;
    };

    new MutationObserver(scanVideos).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', scanVideos);

    // 心跳兜底
    setInterval(() => {
        deepQuery(document, 'video').forEach(v => {
            if (!handled.has(v)) hookVideo(v);
            if (v.paused && v.readyState >= 2 && !v.ended) {
                v.muted = CONFIG.muted;
                v.play().catch(() => {});
            }
            if (Math.abs(v.playbackRate - CONFIG.rate) > 0.01) v.playbackRate = CONFIG.rate;
        });
    }, 1500);

    // ====== 悬浮面板 ======
    function injectUI() {
        if (document.getElementById('tg-autoplay-panel')) return;
        const style = document.createElement('style');
        style.textContent = `
        #tg-autoplay-panel{position:fixed;top:80px;right:20px;z-index:2147483647;
            width:200px;background:#1f2937;color:#e5e7eb;border-radius:8px;
            box-shadow:0 6px 20px rgba(0,0,0,.35);font:12px/1.5 -apple-system,Segoe UI,sans-serif;
            user-select:none}
        #tg-autoplay-panel .tg-hd{padding:8px 10px;background:#111827;border-radius:8px 8px 0 0;
            cursor:move;display:flex;justify-content:space-between;align-items:center}
        #tg-autoplay-panel .tg-hd b{color:#60a5fa;font-size:13px}
        #tg-autoplay-panel .tg-hd span{cursor:pointer;padding:0 6px;color:#9ca3af}
        #tg-autoplay-panel .tg-bd{padding:10px}
        #tg-autoplay-panel .tg-bd.collapsed{display:none}
        #tg-autoplay-panel .row{display:flex;justify-content:space-between;align-items:center;margin:6px 0}
        #tg-autoplay-panel input[type=number]{width:60px;background:#374151;color:#fff;
            border:1px solid #4b5563;border-radius:4px;padding:2px 4px}
        #tg-autoplay-panel .btn{display:block;width:100%;margin-top:6px;padding:5px 0;
            background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer}
        #tg-autoplay-panel .btn:hover{background:#1d4ed8}
        #tg-autoplay-panel .btn.alt{background:#4b5563}
        #tg-autoplay-panel .btn.alt:hover{background:#374151}
        #tg-autoplay-panel .nav{display:flex;gap:4px}
        #tg-autoplay-panel .nav .btn{margin-top:0}
        #tg-autoplay-panel .status{margin-top:8px;padding:6px;background:#111827;
            border-radius:4px;font-size:11px;color:#9ca3af;word-break:break-all}
        #tg-autoplay-panel .dot{display:inline-block;width:8px;height:8px;border-radius:50%;
            background:#10b981;margin-right:4px;vertical-align:middle}
        #tg-autoplay-panel .dot.off{background:#ef4444}
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'tg-autoplay-panel';
        panel.innerHTML = `
        <div class="tg-hd"><b>🎬 头歌刷课</b><span id="tg-toggle">—</span></div>
        <div class="tg-bd" id="tg-body">
            <div class="row"><label>倍速</label>
                <input type="number" id="tg-rate" min="1" max="16" step="0.25" value="${CONFIG.rate}">
            </div>
            <div class="row"><label>静音</label>
                <input type="checkbox" id="tg-muted" ${CONFIG.muted?'checked':''}>
            </div>
            <div class="row"><label>自动下一节</label>
                <input type="checkbox" id="tg-next" ${CONFIG.autoNext?'checked':''}>
            </div>
            <div class="nav">
                <button class="btn alt" id="tg-prev">⏮ 上一节</button>
                <button class="btn" id="tg-next-btn">下一节 ⏭</button>
            </div>
            <button class="btn alt" id="tg-skip">跳到结尾</button>
            <div class="status" id="tg-status">等待视频...</div>
        </div>`;
        document.body.appendChild(panel);

        const body = panel.querySelector('#tg-body');
        panel.querySelector('#tg-toggle').onclick = () => {
            body.classList.toggle('collapsed');
            panel.querySelector('#tg-toggle').textContent = body.classList.contains('collapsed') ? '+' : '—';
        };

        // 拖动
        const hd = panel.querySelector('.tg-hd');
        let dx=0, dy=0, dragging=false;
        hd.addEventListener('mousedown', e => {
            if (e.target.id === 'tg-toggle') return;
            dragging = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop;
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = (e.clientX - dx) + 'px';
            panel.style.top = (e.clientY - dy) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => dragging = false);

        panel.querySelector('#tg-rate').onchange = e => { CONFIG.rate = parseFloat(e.target.value) || 1; saveConfig(); };
        panel.querySelector('#tg-muted').onchange = e => { CONFIG.muted = e.target.checked; saveConfig(); };
        panel.querySelector('#tg-next').onchange = e => { CONFIG.autoNext = e.target.checked; saveConfig(); };
        panel.querySelector('#tg-prev').onclick = gotoPrev;
        panel.querySelector('#tg-next-btn').onclick = gotoNext;
        panel.querySelector('#tg-skip').onclick = () => {
            deepQuery(document, 'video').forEach(v => {
                if (v.duration) v.currentTime = v.duration - 0.5;
            });
        };

        setInterval(() => {
            const videos = deepQuery(document, 'video');
            const status = panel.querySelector('#tg-status');
            const id = currentId();
            if (!videos.length) {
                status.innerHTML = `<span class="dot off"></span>未检测到视频<br>id=${id ?? '无'}`;
                return;
            }
            const v = videos[0];
            const fmt = s => isNaN(s) ? '0:00' :
                `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
            status.innerHTML =
                `<span class="dot ${v.paused?'off':''}"></span>${v.paused?'已暂停':'播放中'} | ${v.playbackRate}x<br>` +
                `${fmt(v.currentTime)} / ${fmt(v.duration)}<br>id=${id ?? '无'}`;
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectUI);
    } else {
        injectUI();
    }

    console.log('[AutoPlay] v3.0.0 已启动', CONFIG);
})();
