
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

    // ====== 视频 id 有序列表（从 API 响应中嗅探）======
    // 存 localStorage，跨页面也能用；按 classroom 路径区分
    const LIST_KEY = 'tg_video_list__' + location.pathname.split('/').slice(0, 3).join('/');
    let videoIdList = (() => {
        try { return JSON.parse(localStorage.getItem(LIST_KEY) || '[]'); } catch { return []; }
    })();
    function saveList() {
        try { localStorage.setItem(LIST_KEY, JSON.stringify(videoIdList)); } catch {}
    }

    // 递归扫描 JSON：只收字段名严格等于 new_video_id / video_id 的值
    // 不收泛化的 "id"（否则会把用户 id、章节 id 等混进来）
    function extractIdsFromJson(obj) {
        const ids = [];
        const walk = (v) => {
            if (!v) return;
            if (Array.isArray(v)) { v.forEach(walk); return; }
            if (typeof v !== 'object') return;
            for (const k of Object.keys(v)) {
                // course_video_id 是头歌 API 里章节 id 的字段名（对应 URL 的 new_video_id）
                if (/^(new_video_id|course_video_id|video_id)$/i.test(k)) {
                    const n = parseInt(v[k], 10);
                    if (!isNaN(n) && n > 0) ids.push(n);
                } else {
                    walk(v[k]);
                }
            }
        };
        walk(obj);
        return ids;
    }

    function mergeIntoList(ids) {
        if (!ids.length) return;
        // 如果本次扫到的有序 id 比现有列表"更全"且包含现有所有 id，就整个替换
        const set = new Set(videoIdList);
        const nowSet = new Set(ids);
        const isSuperset = videoIdList.every(x => nowSet.has(x));
        if (ids.length >= videoIdList.length && isSuperset) {
            if (ids.length !== videoIdList.length || ids.some((x, i) => x !== videoIdList[i])) {
                videoIdList = [...new Set(ids)];
                saveList();
                console.log('[AutoPlay] 更新视频列表', videoIdList);
            }
            return;
        }
        // 否则把新 id 追加到末尾（保序去重）
        let changed = false;
        ids.forEach(id => {
            if (!set.has(id)) { videoIdList.push(id); set.add(id); changed = true; }
        });
        if (changed) { saveList(); console.log('[AutoPlay] 追加到视频列表', videoIdList); }
    }

    function sniffUrl(u) {
        try {
            const m = String(u).match(/(?:new_video_id|video_id)=(\d+)/);
            if (m) {
                const id = parseInt(m[1], 10);
                if (!isNaN(id)) lastKnownId = id;
            }
        } catch {}
    }

    function sniffJson(text) {
        if (!text || text.length > 2_000_000) return;
        try {
            const obj = JSON.parse(text);
            const ids = extractIdsFromJson(obj);
            // 只有响应里含 ≥ 2 个大数字 id 才认为是"列表"类响应
            if (ids.length >= 2) mergeIntoList(ids);
        } catch {}
    }

    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__tgUrl = url;
        sniffUrl(url);
        return _open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => {
            try {
                const ct = this.getResponseHeader('content-type') || '';
                if (ct.includes('json') || (this.responseText && this.responseText.trim().startsWith('{'))) {
                    sniffJson(this.responseText);
                }
            } catch {}
        });
        return _send.apply(this, args);
    };

    const _fetch = window.fetch;
    window.fetch = function (input, init) {
        sniffUrl(typeof input === 'string' ? input : input?.url);
        return _fetch.apply(this, arguments).then(res => {
            try {
                const ct = res.headers.get('content-type') || '';
                if (ct.includes('json')) {
                    res.clone().text().then(sniffJson).catch(() => {});
                }
            } catch {}
            return res;
        });
    };

    function currentId() { return lastKnownId ?? urlId(); }

    // 在页面里找 target id 对应的链接/元素
    function findItemById(targetId) {
        const all = document.querySelectorAll('a[href*="' + PARAM + '="]');
        for (const a of all) {
            try {
                const id = parseInt(new URL(a.href, location.href).searchParams.get(PARAM), 10);
                if (id === targetId) return a;
            } catch {}
        }
        return null;
    }

    function gotoDelta(delta) {
        const id = currentId();
        if (id == null || isNaN(id)) {
            console.warn('[AutoPlay] 找不到当前 video id');
            return;
        }

        // 优先：在嗅探到的有序列表里找
        let nextId = null;
        const idx = videoIdList.indexOf(id);
        if (idx >= 0) {
            const nextIdx = idx + delta;
            if (nextIdx < 0 || nextIdx >= videoIdList.length) {
                console.log(`[AutoPlay] 已到列表${delta > 0 ? '末尾' : '开头'}`);
                return;
            }
            nextId = videoIdList[nextIdx];
            console.log(`[AutoPlay] 列表跳转 [${idx}→${nextIdx}] id=${id} → ${nextId}`);
        } else {
            nextId = id + delta;
            console.warn(`[AutoPlay] 列表里没有 id=${id}，回退到 ±1 → ${nextId}`);
        }

        // 优先点击列表项（SPA 内部切换，不刷新页面）
        const el = findItemById(nextId);
        if (el) {
            console.log('[AutoPlay] 点击列表项', el);
            el.click();
            lastKnownId = nextId;
            return;
        }

        // 兜底：URL 跳转
        console.log('[AutoPlay] 使用 URL 跳转');
        const url = new URL(location.href);
        url.searchParams.set(PARAM, String(nextId));
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
        @keyframes tg-fadeIn { from{opacity:0;transform:translateY(-8px) scale(.98)} to{opacity:1;transform:none} }
        @keyframes tg-bar { 0%,100%{transform:scaleY(.35)} 50%{transform:scaleY(1)} }
        @keyframes tg-shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }

        /* Palette: charcoal cream · acid lime · warm coral */
        #tg-autoplay-panel{
            position:fixed;top:80px;right:20px;z-index:2147483647;width:288px;
            color:#f2ede4;user-select:none;
            font:500 13px/1.5 -apple-system,"SF Pro Display","Segoe UI",sans-serif;
            background:linear-gradient(160deg, rgba(26,24,22,.92), rgba(18,17,16,.92));
            backdrop-filter:blur(24px) saturate(180%);
            -webkit-backdrop-filter:blur(24px) saturate(180%);
            border:1px solid rgba(242,237,228,.08);
            border-radius:18px;
            box-shadow:0 20px 60px -12px rgba(0,0,0,.7), 0 0 0 1px rgba(242,237,228,.04) inset, 0 1px 0 rgba(242,237,228,.06) inset;
            overflow:hidden;
            animation:tg-fadeIn .35s cubic-bezier(.22,.61,.36,1);
        }
        #tg-autoplay-panel::before{
            content:'';position:absolute;inset:-1px;border-radius:inherit;padding:1px;
            background:linear-gradient(135deg,rgba(212,255,60,.45),transparent 45%,rgba(255,107,61,.4));
            -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
            -webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;
        }
        #tg-autoplay-panel .tg-hd{
            display:flex;align-items:center;justify-content:space-between;
            padding:14px 16px 12px;cursor:move;
            background:linear-gradient(180deg,rgba(242,237,228,.03),transparent);
            border-bottom:1px solid rgba(242,237,228,.06);
        }
        #tg-autoplay-panel .tg-title{display:flex;align-items:center;gap:10px}
        #tg-autoplay-panel .tg-logo{
            width:28px;height:28px;border-radius:9px;display:grid;place-items:center;
            background:#d4ff3c;color:#1a1816;
            box-shadow:0 4px 12px rgba(212,255,60,.3), 0 0 0 1px rgba(0,0,0,.1) inset;
            font-size:13px;font-weight:900;
        }
        #tg-autoplay-panel .tg-brand{display:flex;flex-direction:column;line-height:1.1}
        #tg-autoplay-panel .tg-brand b{font-size:13px;font-weight:700;letter-spacing:.3px;color:#f2ede4}
        #tg-autoplay-panel .tg-brand small{font-size:10px;color:#8a8278;font-weight:500;margin-top:3px;letter-spacing:.5px}
        #tg-autoplay-panel .tg-collapse{
            width:22px;height:22px;border-radius:6px;display:grid;place-items:center;cursor:pointer;
            background:rgba(242,237,228,.06);color:#b8b0a4;transition:all .15s;
        }
        #tg-autoplay-panel .tg-collapse:hover{background:rgba(242,237,228,.12);color:#f2ede4}

        #tg-autoplay-panel .tg-bd{padding:14px 16px 16px;display:flex;flex-direction:column;gap:12px}
        #tg-autoplay-panel .tg-bd.collapsed{display:none}

        /* 播放状态卡 */
        #tg-autoplay-panel .tg-now{
            position:relative;padding:12px 14px;border-radius:12px;
            background:linear-gradient(135deg,rgba(212,255,60,.07),rgba(255,107,61,.06));
            border:1px solid rgba(212,255,60,.14);
            overflow:hidden;
        }
        #tg-autoplay-panel .tg-now-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
        #tg-autoplay-panel .tg-wave{display:inline-flex;align-items:flex-end;gap:2px;height:14px}
        #tg-autoplay-panel .tg-wave i{
            width:3px;height:100%;border-radius:2px;background:#d4ff3c;
            animation:tg-bar 1s ease-in-out infinite;transform-origin:bottom;
            box-shadow:0 0 6px rgba(212,255,60,.5);
        }
        #tg-autoplay-panel .tg-wave i:nth-child(2){animation-delay:.15s;background:#e8ff6b}
        #tg-autoplay-panel .tg-wave i:nth-child(3){animation-delay:.3s;background:#ff9f6b}
        #tg-autoplay-panel .tg-wave i:nth-child(4){animation-delay:.45s;background:#ff6b3d}
        #tg-autoplay-panel .tg-now.paused .tg-wave i{animation-play-state:paused;opacity:.35}

        #tg-autoplay-panel .tg-state{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px}
        #tg-autoplay-panel .tg-state-text{color:#f2ede4;letter-spacing:.2px}
        #tg-autoplay-panel .tg-now.paused .tg-state-text{color:#ff9f6b}
        #tg-autoplay-panel .tg-rate-chip{
            padding:3px 8px;border-radius:6px;font-size:11px;font-weight:800;
            background:#d4ff3c;color:#1a1816;letter-spacing:.5px;
            box-shadow:0 2px 8px rgba(212,255,60,.25);
        }
        #tg-autoplay-panel .tg-time{
            margin-top:8px;font-size:11px;color:#8a8278;font-variant-numeric:tabular-nums;
            display:flex;justify-content:space-between;
        }
        #tg-autoplay-panel .tg-time b{color:#f2ede4;font-weight:600}
        #tg-autoplay-panel .tg-prog{
            margin-top:6px;height:4px;background:rgba(242,237,228,.07);border-radius:99px;overflow:hidden;
        }
        #tg-autoplay-panel .tg-prog-fill{
            height:100%;width:0%;border-radius:99px;
            background:linear-gradient(90deg,#d4ff3c,#ffd93c,#ff6b3d);
            background-size:200% 100%;
            box-shadow:0 0 10px rgba(255,107,61,.4);
            transition:width .3s cubic-bezier(.22,.61,.36,1);
            animation:tg-shimmer 3s linear infinite;
        }

        /* 倍速分段 */
        #tg-autoplay-panel .tg-seg{
            display:grid;grid-template-columns:repeat(6,1fr);gap:4px;padding:3px;
            background:rgba(0,0,0,.3);border-radius:10px;
            border:1px solid rgba(242,237,228,.04);
        }
        #tg-autoplay-panel .tg-seg button{
            appearance:none;border:none;background:transparent;color:#8a8278;
            font:600 11px/1 -apple-system,Segoe UI,sans-serif;padding:7px 0;border-radius:7px;cursor:pointer;
            transition:all .18s cubic-bezier(.22,.61,.36,1);letter-spacing:.3px;
        }
        #tg-autoplay-panel .tg-seg button:hover{color:#f2ede4}
        #tg-autoplay-panel .tg-seg button.on{
            background:#d4ff3c;color:#1a1816;font-weight:800;
            box-shadow:0 4px 12px rgba(212,255,60,.3), 0 0 0 1px rgba(0,0,0,.08) inset;
        }

        #tg-autoplay-panel .tg-custom{
            display:flex;gap:6px;margin-top:6px;align-items:center;
            padding:3px;background:rgba(0,0,0,.3);border-radius:10px;
            border:1px solid rgba(242,237,228,.04);
            transition:all .2s;
        }
        #tg-autoplay-panel .tg-custom input{
            flex:1;appearance:none;border:none;background:transparent;outline:none;
            color:#f2ede4;font:600 12px/1 -apple-system,Segoe UI,sans-serif;
            padding:7px 10px;letter-spacing:.3px;min-width:0;
        }
        #tg-autoplay-panel .tg-custom input::placeholder{color:#5a5248;font-weight:500}
        #tg-autoplay-panel .tg-custom input::-webkit-outer-spin-button,
        #tg-autoplay-panel .tg-custom input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
        #tg-autoplay-panel .tg-custom button{
            appearance:none;border:none;cursor:pointer;padding:6px 12px;border-radius:7px;
            font:800 11px/1 -apple-system,Segoe UI,sans-serif;letter-spacing:.8px;
            background:#ff6b3d;color:#fff;
            box-shadow:0 2px 8px rgba(255,107,61,.3);transition:all .18s;
            text-transform:uppercase;
        }
        #tg-autoplay-panel .tg-custom button:hover{filter:brightness(1.08);transform:translateY(-1px)}
        #tg-autoplay-panel .tg-custom button:active{transform:translateY(0)}
        #tg-autoplay-panel .tg-custom.active{
            border-color:rgba(212,255,60,.3);
            box-shadow:0 0 0 3px rgba(212,255,60,.06);
        }

        /* 行 */
        #tg-autoplay-panel .tg-label{font-size:10px;color:#6b6257;font-weight:700;
            text-transform:uppercase;letter-spacing:1.8px;margin-bottom:8px}
        #tg-autoplay-panel .tg-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0}
        #tg-autoplay-panel .tg-row + .tg-row{border-top:1px solid rgba(242,237,228,.05)}
        #tg-autoplay-panel .tg-row span{font-size:12.5px;color:#d4cdc0;font-weight:500}

        /* 开关 */
        #tg-autoplay-panel .tg-switch{position:relative;width:36px;height:20px;cursor:pointer;
            background:rgba(242,237,228,.1);border-radius:99px;transition:background .2s;
            flex-shrink:0}
        #tg-autoplay-panel .tg-switch::after{
            content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
            background:#f2ede4;box-shadow:0 2px 4px rgba(0,0,0,.3);transition:transform .22s cubic-bezier(.22,.61,.36,1);
        }
        #tg-autoplay-panel .tg-switch.on{background:#d4ff3c}
        #tg-autoplay-panel .tg-switch.on::after{transform:translateX(16px);background:#1a1816}

        /* 导航 */
        #tg-autoplay-panel .tg-nav{display:grid;grid-template-columns:1fr 1fr;gap:8px}
        #tg-autoplay-panel .tg-btn{
            appearance:none;border:none;cursor:pointer;padding:10px 12px;border-radius:10px;
            font:600 12px/1 -apple-system,Segoe UI,sans-serif;letter-spacing:.3px;
            display:inline-flex;align-items:center;justify-content:center;gap:6px;
            transition:all .18s cubic-bezier(.22,.61,.36,1);
            background:rgba(242,237,228,.06);color:#f2ede4;
            border:1px solid rgba(242,237,228,.05);
        }
        #tg-autoplay-panel .tg-btn:hover{background:rgba(242,237,228,.1);transform:translateY(-1px);
            box-shadow:0 6px 14px rgba(0,0,0,.3)}
        #tg-autoplay-panel .tg-btn:active{transform:translateY(0)}
        #tg-autoplay-panel .tg-btn.primary{
            background:#d4ff3c;color:#1a1816;font-weight:800;letter-spacing:.5px;
            box-shadow:0 4px 14px rgba(212,255,60,.3);border-color:transparent;
        }
        #tg-autoplay-panel .tg-btn.primary:hover{
            box-shadow:0 8px 22px rgba(212,255,60,.45);
            filter:brightness(1.05);
        }
        #tg-autoplay-panel .tg-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:2px}
        #tg-autoplay-panel .tg-actions .tg-btn{padding:8px 4px;font-size:11px;flex-direction:column;gap:3px}
        #tg-autoplay-panel .tg-actions .tg-btn i{font-size:13px;font-style:normal}

        /* 底部元信息 */
        #tg-autoplay-panel .tg-meta{
            display:flex;justify-content:space-between;align-items:center;
            padding-top:10px;margin-top:2px;border-top:1px solid rgba(242,237,228,.06);
            font-size:10.5px;color:#6b6257;font-weight:500;letter-spacing:.3px;
        }
        #tg-autoplay-panel .tg-meta-dot{
            display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;vertical-align:middle;
            background:#d4ff3c;box-shadow:0 0 8px rgba(212,255,60,.7);
        }
        #tg-autoplay-panel .tg-meta-dot.off{background:#5a5248;box-shadow:none}
        #tg-autoplay-panel .tg-meta-id{color:#d4cdc0;font-variant-numeric:tabular-nums}
        `;
        document.head.appendChild(style);

        const RATES = [1, 1.5, 2, 2.5, 3, 4];
        const panel = document.createElement('div');
        panel.id = 'tg-autoplay-panel';
        panel.innerHTML = `
        <div class="tg-hd">
            <div class="tg-title">
                <div class="tg-logo">▶</div>
                <div class="tg-brand"><b>Educoder Flow</b><small>智能刷课 · 自动播放</small></div>
            </div>
            <div class="tg-collapse" id="tg-toggle">−</div>
        </div>
        <div class="tg-bd" id="tg-body">
            <div class="tg-now" id="tg-now">
                <div class="tg-now-row">
                    <div class="tg-state">
                        <div class="tg-wave"><i></i><i></i><i></i><i></i></div>
                        <span class="tg-state-text" id="tg-state-text">等待视频</span>
                    </div>
                    <span class="tg-rate-chip" id="tg-rate-chip">${CONFIG.rate}×</span>
                </div>
                <div class="tg-time"><b id="tg-time-cur">0:00</b><span id="tg-time-dur">0:00</span></div>
                <div class="tg-prog"><div class="tg-prog-fill" id="tg-prog"></div></div>
            </div>

            <div>
                <div class="tg-label">播放速度</div>
                <div class="tg-seg" id="tg-seg">
                    ${RATES.map(r => `<button data-r="${r}">${r}×</button>`).join('')}
                </div>
                <div class="tg-custom" id="tg-custom">
                    <input type="number" id="tg-custom-input" min="0.25" max="16" step="0.25" placeholder="自定义倍速…" value="${RATES.includes(CONFIG.rate) ? '' : CONFIG.rate}">
                    <button id="tg-custom-apply">应用</button>
                </div>
            </div>

            <div>
                <div class="tg-label">偏好</div>
                <div class="tg-row"><span>静音播放</span><div class="tg-switch ${CONFIG.muted?'on':''}" id="tg-muted-sw"></div></div>
                <div class="tg-row"><span>自动下一节</span><div class="tg-switch ${CONFIG.autoNext?'on':''}" id="tg-next-sw"></div></div>
            </div>

            <div>
                <div class="tg-label">导航</div>
                <div class="tg-nav">
                    <button class="tg-btn" id="tg-prev">◀ 上一节</button>
                    <button class="tg-btn primary" id="tg-next-btn">下一节 ▶</button>
                </div>
                <div class="tg-actions" style="margin-top:8px">
                    <button class="tg-btn" id="tg-skip"><i>⏭</i>跳结尾</button>
                    <button class="tg-btn" id="tg-show-list"><i>📋</i>列表</button>
                    <button class="tg-btn" id="tg-clear-list"><i>🗑</i>清空</button>
                </div>
            </div>

            <div class="tg-meta">
                <span><span class="tg-meta-dot off" id="tg-meta-dot"></span><span id="tg-meta-txt">未检测</span></span>
                <span class="tg-meta-id" id="tg-meta-id">—</span>
            </div>
        </div>`;

        // 隐藏输入控件保留兼容性（保留原 id）
        const hidden = document.createElement('div');
        hidden.style.display = 'none';
        hidden.innerHTML = `
            <input type="number" id="tg-rate" value="${CONFIG.rate}">
            <input type="checkbox" id="tg-muted" ${CONFIG.muted?'checked':''}>
            <input type="checkbox" id="tg-next" ${CONFIG.autoNext?'checked':''}>`;
        panel.appendChild(hidden);
        document.body.appendChild(panel);

        // 折叠
        const body = panel.querySelector('#tg-body');
        panel.querySelector('#tg-toggle').onclick = () => {
            body.classList.toggle('collapsed');
            panel.querySelector('#tg-toggle').textContent = body.classList.contains('collapsed') ? '+' : '−';
        };

        // 拖动
        const hd = panel.querySelector('.tg-hd');
        let dx=0, dy=0, dragging=false;
        hd.addEventListener('mousedown', e => {
            if (e.target.closest('#tg-toggle')) return;
            dragging = true;
            dx = e.clientX - panel.offsetLeft;
            dy = e.clientY - panel.offsetTop;
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = (e.clientX - dx) + 'px';
            panel.style.top = (e.clientY - dy) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => dragging = false);

        // 倍速分段 + 自定义
        const seg = panel.querySelector('#tg-seg');
        const customBox = panel.querySelector('#tg-custom');
        const customInput = panel.querySelector('#tg-custom-input');
        const renderSeg = () => {
            let hit = false;
            seg.querySelectorAll('button').forEach(b => {
                const match = Math.abs(parseFloat(b.dataset.r) - CONFIG.rate) < 0.01;
                b.classList.toggle('on', match);
                if (match) hit = true;
            });
            customBox.classList.toggle('active', !hit);
            if (!hit && document.activeElement !== customInput) {
                customInput.value = CONFIG.rate;
            }
        };
        seg.addEventListener('click', e => {
            const b = e.target.closest('button');
            if (!b) return;
            CONFIG.rate = parseFloat(b.dataset.r);
            customInput.value = '';
            saveConfig();
            renderSeg();
        });

        const applyCustom = () => {
            let r = parseFloat(customInput.value);
            if (isNaN(r) || r <= 0) return;
            r = Math.max(0.25, Math.min(16, r));
            CONFIG.rate = r;
            customInput.value = r;
            saveConfig();
            renderSeg();
        };
        panel.querySelector('#tg-custom-apply').onclick = applyCustom;
        customInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); applyCustom(); }
        });
        renderSeg();

        // 开关
        const bindSwitch = (elId, key) => {
            const sw = panel.querySelector(elId);
            sw.onclick = () => {
                CONFIG[key] = !CONFIG[key];
                sw.classList.toggle('on', CONFIG[key]);
                saveConfig();
            };
        };
        bindSwitch('#tg-muted-sw', 'muted');
        bindSwitch('#tg-next-sw', 'autoNext');

        panel.querySelector('#tg-prev').onclick = gotoPrev;
        panel.querySelector('#tg-next-btn').onclick = gotoNext;
        panel.querySelector('#tg-skip').onclick = () => {
            deepQuery(document, 'video').forEach(v => { if (v.duration) v.currentTime = v.duration - 0.5; });
        };
        panel.querySelector('#tg-show-list').onclick = () => {
            const id = currentId();
            console.log('[AutoPlay] 当前列表', videoIdList, '当前 id=', id, '位置=', videoIdList.indexOf(id));
            alert(`列表共 ${videoIdList.length} 项\n当前 id=${id}，位于第 ${videoIdList.indexOf(id) + 1} 项\n\n前 20 项：\n${videoIdList.slice(0,20).join(', ')}${videoIdList.length > 20 ? '\n...' : ''}`);
        };
        panel.querySelector('#tg-clear-list').onclick = () => {
            videoIdList = [];
            saveList();
            alert('已清空。刷新页面重新嗅探。');
        };

        // 状态刷新
        const now = panel.querySelector('#tg-now');
        const stateText = panel.querySelector('#tg-state-text');
        const rateChip = panel.querySelector('#tg-rate-chip');
        const tCur = panel.querySelector('#tg-time-cur');
        const tDur = panel.querySelector('#tg-time-dur');
        const prog = panel.querySelector('#tg-prog');
        const metaDot = panel.querySelector('#tg-meta-dot');
        const metaTxt = panel.querySelector('#tg-meta-txt');
        const metaId = panel.querySelector('#tg-meta-id');

        setInterval(() => {
            const videos = deepQuery(document, 'video');
            const id = currentId();
            const v = videos[0];

            // 元信息
            if (videoIdList.length && id != null) {
                const pos = videoIdList.indexOf(id);
                metaDot.classList.remove('off');
                metaTxt.textContent = pos >= 0 ? `第 ${pos + 1} / ${videoIdList.length} 节` : `列表 ${videoIdList.length} 节`;
            } else {
                metaDot.classList.add('off');
                metaTxt.textContent = '列表未嗅探';
            }
            metaId.textContent = id != null ? `#${id}` : '—';

            // 播放状态
            rateChip.textContent = CONFIG.rate + '×';
            if (!v) {
                now.classList.add('paused');
                stateText.textContent = '等待视频';
                tCur.textContent = '0:00';
                tDur.textContent = '0:00';
                prog.style.width = '0%';
                return;
            }
            const fmt = s => isNaN(s) ? '0:00' :
                `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
            now.classList.toggle('paused', v.paused);
            stateText.textContent = v.paused ? '已暂停' : '播放中';
            rateChip.textContent = (v.playbackRate || CONFIG.rate) + '×';
            tCur.textContent = fmt(v.currentTime);
            tDur.textContent = fmt(v.duration);
            prog.style.width = (v.duration ? (v.currentTime / v.duration * 100) : 0).toFixed(2) + '%';
        }, 400);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectUI);
    } else {
        injectUI();
    }

    console.log('[AutoPlay] v5.0.0 已启动', CONFIG);
})();
