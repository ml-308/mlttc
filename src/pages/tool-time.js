// src/pages/tool-time.js
/**
 * 时间与日期工具（/tool-time.html）的交互逻辑
 *
 * 职责：
 *   1. 顶部「当前时间」每秒刷新（本地时间 / 秒级 / 毫秒时间戳 / UTC）
 *   2. 时间戳 → 日期：自动识别秒 / 毫秒 / 微秒
 *   3. 日期 → 时间戳：datetime-local 输入按本地时区解析
 *   4. 日期差 / 倒计时：给出天时分秒拆解与「还有 / 已过」提示
 *
 * 全部为本机时区的本地运算，不发任何请求。
 */
import { showMessage } from '/lib/ui/message.mjs';
import { $ } from './tool-utils.mjs';

/** 补零 */
function pad(n) {
    return n < 10 ? '0' + n : String(n);
}

/** Date → 「YYYY-MM-DD HH:mm:ss (周X)」 */
function fmtLocal(d) {
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
        + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' 周' + week;
}

/** Date → datetime-local 输入框需要的值 */
function toInputValue(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 相对时间描述：还有 X / X 前 */
function relTime(ms) {
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const units = [
        ['年', 365 * 86400000],
        ['天', 86400000],
        ['小时', 3600000],
        ['分钟', 60000],
        ['秒', 1000],
    ];
    let left = abs;
    const parts = [];
    for (let i = 0; i < units.length; i++) {
        const v = Math.floor(left / units[i][1]);
        if (v > 0 || (parts.length > 0 && i < 3)) {
            if (v > 0) parts.push(v + ' ' + units[i][0]);
            left -= v * units[i][1];
        }
        if (parts.length >= 2) break;
    }
    if (!parts.length) parts.push('不到 1 秒');
    const s = parts.join(' ');
    return diff >= 0 ? '还有 ' + s : s + '前';
}

/** 把 [标签, 值] 数组渲染进结果卡片 */
function fillResult(box, rows) {
    box.innerHTML = '';
    rows.forEach((row) => {
        const p = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = row[0];
        const code = document.createElement('code');
        code.textContent = row[1];
        p.appendChild(strong);
        p.appendChild(code);
        box.appendChild(p);
    });
    box.classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
    if (!$('nowLocal')) return;

    // ---------- 1. 当前时间（每秒刷新） ----------
    function tick() {
        const now = new Date();
        $('nowLocal').textContent = fmtLocal(now);
        $('nowSec').textContent = String(Math.floor(now.getTime() / 1000));
        $('nowMs').textContent = String(now.getTime());
        $('nowUtc').textContent = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    }
    tick();
    setInterval(tick, 1000);

    // ---------- 2. 时间戳 → 日期 ----------
    /** 按位数猜测单位：<=11 位按秒，<=14 位按毫秒，再大按微秒/纳秒 */
    function parseTimestamp(raw) {
        const s = raw.replace(/[,\s，]/g, '');
        if (!/^-?\d+$/.test(s)) return null;
        const digits = s.replace('-', '').length;
        let ms;
        if (digits <= 11) ms = Number(s) * 1000;
        else if (digits <= 14) ms = Number(s);
        else if (digits <= 17) ms = Number(s) / 1000;
        else ms = Number(s) / 1000000;
        if (!isFinite(ms) || Math.abs(ms) > 8640000000000000) return null;
        return ms;
    }

    $('tsBtn').addEventListener('click', () => {
        const raw = $('tsIn').value.trim();
        if (!raw) {
            showMessage('请先输入时间戳', true);
            return;
        }
        const ms = parseTimestamp(raw);
        if (ms === null) {
            showMessage('时间戳格式不正确（只支持整数）', true);
            return;
        }
        const d = new Date(ms);
        if (isNaN(d.getTime())) {
            showMessage('该时间戳超出了可表示的日期范围', true);
            return;
        }
        fillResult($('tsOut'), [
            ['本地时间', fmtLocal(d)],
            ['UTC', d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')],
            ['毫秒时间戳', String(d.getTime())],
            ['相对现在', relTime(d.getTime())],
        ]);
    });

    $('tsNowBtn').addEventListener('click', () => {
        $('tsIn').value = String(Math.floor(Date.now() / 1000));
        $('tsBtn').click();
    });

    // ---------- 3. 日期 → 时间戳 ----------
    function convertDateInput() {
        const raw = $('dtIn').value;
        if (!raw) {
            showMessage('请先选择时间', true);
            return;
        }
        const d = new Date(raw);
        if (isNaN(d.getTime())) {
            showMessage('日期格式不正确', true);
            return;
        }
        fillResult($('dtOut'), [
            ['本地时间', fmtLocal(d)],
            ['秒级时间戳', String(Math.floor(d.getTime() / 1000))],
            ['毫秒时间戳', String(d.getTime())],
            ['ISO 8601', d.toISOString()],
        ]);
    }

    $('dtBtn').addEventListener('click', convertDateInput);
    $('dtNowBtn').addEventListener('click', () => {
        $('dtIn').value = toInputValue(new Date());
        convertDateInput();
    });

    // ---------- 4. 日期差 / 倒计时 ----------
    function calcDiff() {
        const a = new Date($('fromIn').value);
        const b = new Date($('toIn').value);
        if (isNaN(a.getTime()) || isNaN(b.getTime())) {
            showMessage('请把开始与结束时间都填上', true);
            return;
        }
        const sign = b.getTime() >= a.getTime() ? 1 : -1;
        const abs = Math.abs(b.getTime() - a.getTime());
        const days = Math.floor(abs / 86400000);
        const hours = Math.floor((abs % 86400000) / 3600000);
        const minutes = Math.floor((abs % 3600000) / 60000);
        const seconds = Math.floor((abs % 60000) / 1000);
        fillResult($('diffOut'), [
            ['开始', fmtLocal(a)],
            ['结束', fmtLocal(b)],
            ['差值', days + ' 天 ' + hours + ' 小时 ' + minutes + ' 分 ' + seconds + ' 秒'],
            ['总计', Math.floor(abs / 1000) + ' 秒 ≈ ' + (abs / 3600000).toFixed(2) + ' 小时 ≈ ' + (abs / 86400000).toFixed(2) + ' 天'],
            ['结论', sign > 0 ? '结束晚于开始：' + relTime(b.getTime()) : '结束早于开始（相差 ' + Math.ceil(abs / 86400000) + ' 天）'],
        ]);
    }

    $('diffBtn').addEventListener('click', calcDiff);

    $('diffNowBtn').addEventListener('click', () => {
        const now = new Date();
        $('fromIn').value = toInputValue(now);
        $('toIn').value = toInputValue(new Date(now.getTime() + 30 * 86400000));
        calcDiff();
    });

    // 高考倒计时：与首页 hero 的目标时间保持一致（2028-06-07 08:00）
    $('diffExamBtn').addEventListener('click', () => {
        $('fromIn').value = toInputValue(new Date());
        $('toIn').value = toInputValue(new Date(2028, 5, 7, 8, 0, 0));
        calcDiff();
    });
});
