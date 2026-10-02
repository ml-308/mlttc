// src/pages/tool-password.js
/**
 * 密码生成器（/tool-password.html）的交互逻辑
 *
 * 职责：
 *   1. 按长度 / 字符集选项生成密码（crypto.getRandomValues，非 Math.random）
 *   2. 强度预估（熵值 = 长度 × log2(字符集大小)）并驱动进度条
 *   3. 设置项写入 localStorage，下次打开自动恢复
 *
 * 约定：密码只在本地生成与展示，不发送任何请求、不入库。
 */
import { showMessage } from '/lib/ui/message.mjs';
import { $, copyText } from './tool-utils.mjs';

const SETS = {
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower: 'abcdefghijklmnopqrstuvwxyz',
    digit: '0123456789',
    symbol: '!@#$%^&*()-_=+[]{};:,.<>?',
};
/** 易混淆字符（勾选「排除」时从候选集中剔除） */
const AMBIGUOUS = '0Oo1lI';
const STORAGE_KEY = 'mlttc-pwgen';

/** 取 [0, max) 的密码学随机整数（拒绝采样，保证无偏） */
function randInt(max) {
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    let v;
    do {
        crypto.getRandomValues(buf);
        v = buf[0];
    } while (v >= limit);
    return v % max;
}

/** Fisher-Yates 洗牌（就地） */
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = randInt(i + 1);
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
    }
    return arr;
}

/** 读取当前勾选的字符集，返回 { pool, groups } */
function readOptions() {
    const dropAmbig = $('optAmbig').checked;
    const keep = (s) => (dropAmbig ? Array.from(s).filter((c) => !AMBIGUOUS.includes(c)).join('') : s);
    const groups = [];
    if ($('optUpper').checked) groups.push(keep(SETS.upper));
    if ($('optLower').checked) groups.push(keep(SETS.lower));
    if ($('optDigit').checked) groups.push(keep(SETS.digit));
    if ($('optSymbol').checked) groups.push(keep(SETS.symbol));
    const pool = groups.join('');
    return { pool, groups };
}

/** 生成一个密码：先保证每个选中的字符集至少出现一次，再补齐并洗牌 */
function makePassword(length, pool, groups) {
    const chars = [];
    groups.forEach((g) => {
        if (g && chars.length < length) chars.push(g[randInt(g.length)]);
    });
    while (chars.length < length) chars.push(pool[randInt(pool.length)]);
    return shuffle(chars).join('');
}

/** 熵值（bit）与强度等级 */
function strength(length, poolSize) {
    const entropy = length * Math.log2(poolSize);
    if (entropy < 40) return { entropy, level: '弱', color: 'var(--danger)', pct: 25 };
    if (entropy < 60) return { entropy, level: '中', color: 'var(--warning)', pct: 50 };
    if (entropy < 80) return { entropy, level: '强', color: 'var(--primary)', pct: 75 };
    return { entropy, level: '很强', color: 'var(--success)', pct: 100 };
}

/** 把设置存进 localStorage（失败时静默忽略：隐私模式可能禁用存储） */
function saveOptions() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            len: Number($('pwLen').value),
            count: Number($('pwCount').value),
            upper: $('optUpper').checked,
            lower: $('optLower').checked,
            digit: $('optDigit').checked,
            symbol: $('optSymbol').checked,
            ambig: $('optAmbig').checked,
        }));
    } catch (err) { /* 忽略 */ }
}

/** 恢复上次的设置 */
function loadOptions() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (err) {
        saved = null;
    }
    if (!saved) return;
    if (saved.len) $('pwLen').value = String(saved.len);
    if (saved.count) $('pwCount').value = String(saved.count);
    ['upper', 'lower', 'digit', 'symbol', 'ambig'].forEach((k) => {
        if (typeof saved[k] === 'boolean') $('opt' + k.charAt(0).toUpperCase() + k.slice(1)).checked = saved[k];
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const out = $('pwOut');
    if (!out) return;
    let lastList = [];

    // 长度滑块：即时显示数值
    function renderLen() {
        $('pwLenLabel').textContent = $('pwLen').value + ' 位';
    }

    // 强度预览（不生成也能看到当前字符集的熵值）
    function renderStrength() {
        const length = Number($('pwLen').value);
        const { pool, groups } = readOptions();
        const usable = groups.filter((g) => g.length > 0).length;
        if (!pool.length || usable === 0) {
            $('pwLevel').textContent = '—';
            $('pwEntropy').textContent = '至少勾选一种字符集';
            $('pwMeterBar').style.width = '0';
            return;
        }
        const s = strength(length, pool.length);
        $('pwLevel').textContent = s.level;
        $('pwEntropy').textContent = '熵值约 ' + s.entropy.toFixed(1) + ' bit（字符集 ' + pool.length + ' 种）';
        $('pwMeterBar').style.width = s.pct + '%';
        $('pwMeterBar').style.background = s.color;
    }

    function renderOutput() {
        out.innerHTML = '';
        if (!lastList.length) {
            out.classList.add('hidden');
            return;
        }
        lastList.forEach((pw, i) => {
            const p = document.createElement('p');
            const no = document.createElement('strong');
            no.textContent = (i + 1) + '. ';
            const code = document.createElement('code');
            code.textContent = pw;
            p.appendChild(no);
            p.appendChild(code);
            out.appendChild(p);
        });
        out.classList.remove('hidden');
    }

    function generate() {
        const { pool, groups } = readOptions();
        if (!pool.length || groups.every((g) => !g.length)) {
            showMessage('至少勾选一种字符集', true);
            return;
        }
        let count = Math.floor(Number($('pwCount').value));
        if (!Number.isFinite(count) || count < 1) count = 1;
        if (count > 10) count = 10;
        $('pwCount').value = String(count);

        const length = Math.min(64, Math.max(6, Math.floor(Number($('pwLen').value)) || 16));
        lastList = [];
        for (let i = 0; i < count; i++) lastList.push(makePassword(length, pool, groups.filter((g) => g.length)));
        renderOutput();
        renderStrength();
        saveOptions();
        showMessage('已生成 ' + count + ' 个密码');
    }

    $('genBtn').addEventListener('click', generate);
    $('copyPwBtn').addEventListener('click', () => copyText(lastList.join('\n')));
    $('clearPwBtn').addEventListener('click', () => {
        lastList = [];
        renderOutput();
        showMessage('已清空结果');
    });

    ['pwLen', 'pwCount', 'optUpper', 'optLower', 'optDigit', 'optSymbol', 'optAmbig'].forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.addEventListener('input', () => { renderLen(); renderStrength(); saveOptions(); });
        el.addEventListener('change', () => { renderLen(); renderStrength(); saveOptions(); });
    });

    loadOptions();
    renderLen();
    renderStrength();
});
