// src/pages/tool-life.js
/**
 * 生活工具箱（/tool-life.html）的交互逻辑
 *
 * 职责：
 *   1. 人民币金额大写：数字金额 → 会计规范大写（精确到分，四舍五入）
 *   2. 身份证号校验：18 位校验码、15 位旧证升级，解析生日 / 年龄 / 性别 / 省份
 *   3. 秒表：毫秒级计时 + 分段计次
 *   4. 倒计时：自定义时长，结束提示并响铃
 *   5. 月历：按月生成（周一起头、ISO 周次、标注今天）
 *
 * 依赖：/lib/ui/message.mjs、./tool-utils.mjs
 * 全程本地运算，不上传数据。
 */
import { showMessage } from '/lib/ui/message.mjs';
import { $, copyText } from './tool-utils.mjs';

/* =====================================================================
 * 共用小工具
 * ===================================================================== */

/** 往结果卡片写一行：<strong>标题</strong><code>内容</code>…（全部 textContent） */
function row(box, title, codes) {
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = title + ' ';
    p.appendChild(strong);
    (Array.isArray(codes) ? codes : [codes]).forEach((c) => {
        const code = document.createElement('code');
        code.textContent = String(c);
        p.appendChild(code);
    });
    box.appendChild(p);
}

/** 两位补零 */
function p2(n) {
    return String(n).padStart(2, '0');
}

/** 列表页锚点直达某张卡片（滚动到吸顶页头下方） */
function scrollToHash() {
    const id = location.hash.slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    const header = document.querySelector('hcw-body-header');
    const offset = (header ? header.offsetHeight : 0) + 12;
    const top = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

/* =====================================================================
 * 1. 人民币金额大写
 * ===================================================================== */

const RMB_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const RMB_UNITS = ['', '拾', '佰', '仟'];
const RMB_SECS = ['', '万', '亿', '万亿'];

/** 0-9999 一节转大写，内部自动补零（如 1005 → 壹仟零伍） */
function rmbSection(n) {
    const digits = String(n).padStart(4, '0').split('').map(Number);   // 千 百 十 个
    let out = '';
    let pendingZero = false;
    for (let i = 0; i < 4; i++) {
        const d = digits[i];
        if (d === 0) {
            pendingZero = out !== '';
        } else {
            if (pendingZero) out += '零';
            pendingZero = false;
            out += RMB_DIGITS[d] + RMB_UNITS[3 - i];
        }
    }
    return out;
}

/** 纯整数字符串（无符号）转大写，按 4 位一节分组 */
function rmbInt(numStr) {
    const groups = [];
    for (let i = numStr.length; i > 0; i -= 4) {
        groups.unshift(numStr.slice(Math.max(0, i - 4), i));
    }
    let out = '';
    let needZero = false;
    for (let g = 0; g < groups.length; g++) {
        const n = parseInt(groups[g], 10);
        const sec = RMB_SECS[groups.length - 1 - g];
        if (n === 0) {
            needZero = out !== '';
            continue;
        }
        if (out !== '' && (needZero || n < 1000)) out += '零';
        needZero = false;
        out += rmbSection(n) + sec;
    }
    return out || '零';
}

/**
 * 金额 → 人民币大写
 * @param {*} input 数字或字符串，支持负数、逗号分隔，超过两位小数四舍五入
 * @returns {string|null} 非法输入返回 null
 */
function rmbConvert(input) {
    let s = String(input == null ? '' : input).replace(/[,，\s]/g, '');
    if (!/^-?\d*(\.\d+)?$/.test(s) || s === '' || s === '-' || s === '.') return null;
    let neg = false;
    if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
    const parts = s.split('.');
    let yuan = (parts[0] || '0').replace(/^0+(?=\d)/, '');
    if (yuan.length > 16) return null;
    let cents = 0;
    if (parts[1] !== undefined) {
        cents = Number((parts[1] + '00').slice(0, 2));            // 角分
        const third = Number(parts[1].charAt(2) || '0');           // 第三位用于四舍五入
        if (third >= 5) cents += 1;
        if (cents >= 100) {
            cents -= 100;
            yuan = String(Number(yuan) + 1);
        }
    }
    const jiao = Math.floor(cents / 10);
    const fen = cents % 10;
    let out = rmbInt(yuan) + '元';
    if (jiao === 0 && fen === 0) {
        out += '整';
    } else {
        out += jiao > 0 ? RMB_DIGITS[jiao] + '角' : '零';
        if (fen > 0) out += RMB_DIGITS[fen] + '分';
        else if (jiao > 0) out += '整';
    }
    return (neg ? '负' : '') + out;
}

/* =====================================================================
 * 2. 身份证号校验
 * ===================================================================== */

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECKS = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
const ID_PROVINCES = {
    11: '北京', 12: '天津', 13: '河北', 14: '山西', 15: '内蒙古',
    21: '辽宁', 22: '吉林', 23: '黑龙江', 31: '上海', 32: '江苏',
    33: '浙江', 34: '安徽', 35: '福建', 36: '江西', 37: '山东',
    41: '河南', 42: '湖北', 43: '湖南', 44: '广东', 45: '广西',
    46: '海南', 50: '重庆', 51: '四川', 52: '贵州', 53: '云南',
    54: '西藏', 61: '陕西', 62: '甘肃', 63: '青海', 64: '宁夏',
    65: '新疆', 71: '台湾', 81: '香港', 82: '澳门', 91: '国外'
};
const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

/** 由前 17 位算出第 18 位校验码 */
function idCheckChar(s17) {
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += Number(s17.charAt(i)) * ID_WEIGHTS[i];
    return ID_CHECKS[sum % 11];
}

/** 清洗输入：去空格 / 横线、转大写，15 位旧证自动升 18 位；非法返回 null */
function idNormalize(raw) {
    let s = String(raw == null ? '' : raw).replace(/[\s-]/g, '').toUpperCase();
    if (/^\d{15}$/.test(s)) {
        const yy = Number(s.slice(6, 8));
        s = s.slice(0, 6) + (yy > 30 ? '19' : '20') + s.slice(6);
        s = s + idCheckChar(s);
    }
    return /^\d{17}[0-9X]$/.test(s) ? s : null;
}

/** 生日 → 星座名 */
function idStarSign(m, d) {
    const starts = [20, 19, 21, 20, 21, 22, 23, 23, 23, 24, 23, 22];   // 每月进入该月星座的日期
    const names = ['水瓶', '双鱼', '白羊', '金牛', '双子', '巨蟹',
        '狮子', '处女', '天秤', '天蝎', '射手', '摩羯'];
    return d >= starts[m - 1] ? names[m - 1] : names[(m + 10) % 12];
}

/**
 * 解析身份证
 * @returns {{ok:boolean, reason?:string, checkOk?:boolean, expect?:string,
 *   province?:string, birth?:string, age?:number, sex?:string, zodiac?:string, star?:string}}
 */
function idParse(raw) {
    const s = idNormalize(raw);
    if (!s) return { ok: false, reason: '格式不对：应为 15 或 18 位数字' };
    const expect = idCheckChar(s.slice(0, 17));
    const y = Number(s.slice(6, 10));
    const m = Number(s.slice(10, 12));
    const d = Number(s.slice(12, 14));
    const birth = new Date(y, m - 1, d);
    const now = new Date();
    const dateOk = birth.getFullYear() === y && birth.getMonth() === m - 1
        && birth.getDate() === d && birth <= now;
    if (!dateOk) return { ok: false, reason: '出生日期不合法' };
    let age = now.getFullYear() - y;
    if (now.getMonth() < m - 1 || (now.getMonth() === m - 1 && now.getDate() < d)) age--;
    return {
        ok: true,
        checkOk: expect === s.charAt(17),
        expect,
        province: ID_PROVINCES[Number(s.slice(0, 2))] || '未知地区',
        birth: y + '-' + p2(m) + '-' + p2(d),
        age: age >= 0 ? age : 0,
        sex: Number(s.charAt(16)) % 2 === 1 ? '男' : '女',
        zodiac: ZODIAC[((y - 4) % 12 + 12) % 12],
        star: idStarSign(m, d)
    };
}

/* =====================================================================
 * 3. 秒表 / 4. 倒计时 计时核心
 * ===================================================================== */

/** 毫秒 → 00:00.00（超过一小时带小时位） */
function fmtStopwatch(ms) {
    const cs = Math.floor(ms / 10) % 100;
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 60000) % 60;
    const h = Math.floor(ms / 3600000);
    return (h > 0 ? p2(h) + ':' : '') + p2(m) + ':' + p2(s) + '.' + p2(cs);
}

/** 毫秒 → 05:00（向上取整，到点正好显示 00:00） */
function fmtCountdown(ms) {
    const total = Math.ceil(Math.max(0, ms) / 1000);
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    return (h > 0 ? p2(h) + ':' : '') + p2(m) + ':' + p2(s);
}

/** 倒计时结束的提示音（WebAudio 合成，无需音频文件） */
function cdBeep() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.value = 0.15;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        setTimeout(() => { osc.stop(); ctx.close(); }, 700);
    } catch (e) {
        /* 不支持就算了，提示消息仍然有 */
    }
}

/* =====================================================================
 * 5. 月历
 * ===================================================================== */

/** ISO-8601 周数（周一为一周起点） */
function isoWeek(date) {
    const t = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}

/** 星期几的中文名（0 = 周日） */
function weekdayName(day) {
    return ['日', '一', '二', '三', '四', '五', '六'][day];
}

/**
 * 生成月历到结果卡片
 * @param {number} year 年份
 * @param {number} month 1-12
 * @param {HTMLElement} box 结果卡片
 * @returns {boolean} 是否成功
 */
function calRender(year, month, box) {
    if (!(year >= 1901 && year <= 2999)) { showMessage('年份需在 1901-2999 之间', true); return false; }
    if (!(month >= 1 && month <= 12)) { showMessage('月份需在 1-12 之间', true); return false; }
    const first = new Date(year, month - 1, 1);
    const days = new Date(year, month, 0).getDate();
    const startIdx = (first.getDay() + 6) % 7;          // 周一起头
    const today = new Date();

    box.classList.remove('hidden');
    box.innerHTML = '';
    row(box, year + ' 年 ' + month + ' 月', ['共 ' + days + ' 天']);

    // 表头：周次 + 周一 … 周日
    row(box, '周次', ['周一', '周二', '周三', '周四', '周五', '周六', '周日']);

    // 按周铺格子
    const cells = [];
    for (let i = 0; i < startIdx; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);

    for (let w = 0; w < cells.length / 7; w++) {
        const rowDate = new Date(year, month - 1, 1);
        rowDate.setDate(1 - startIdx + w * 7);
        const p = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = '第 ' + isoWeek(rowDate) + ' 周 ';
        p.appendChild(strong);
        for (let c = 0; c < 7; c++) {
            const d = cells[w * 7 + c];
            if (d === null) {
                const code = document.createElement('code');
                code.textContent = '·';
                p.appendChild(code);
            } else if (today.getFullYear() === year
                && today.getMonth() === month - 1
                && today.getDate() === d) {
                const s2 = document.createElement('strong');   // 今天：不带底色的加粗数字
                s2.textContent = d;
                p.appendChild(s2);
            } else {
                const code = document.createElement('code');
                code.textContent = d;
                p.appendChild(code);
            }
        }
        box.appendChild(p);
    }

    const lastDay = new Date(year, month - 1, days);
    row(box, '今天', [
        today.getFullYear() + '-' + p2(today.getMonth() + 1) + '-' + p2(today.getDate()),
        '星期' + weekdayName(today.getDay())
    ]);
    row(box, '当月', [
        '1 号星期' + weekdayName(first.getDay()),
        days + ' 号星期' + weekdayName(lastDay.getDay())
    ]);
    return true;
}

/* =====================================================================
 * 页面交互
 * ===================================================================== */
document.addEventListener('DOMContentLoaded', () => {
    if (!$('rmbIn')) return;

    /** 结果卡片写入并返回可复制文本 */
    function showBox(box, lines) {
        box.classList.remove('hidden');
        box.innerHTML = '';
        lines.forEach((ln) => row(box, ln[0], ln[1]));
    }

    /** 读取一个数字输入，非法返回 null */
    function readNum(id) {
        const v = parseFloat($(id).value);
        return Number.isFinite(v) ? v : null;
    }

    // ---------- 1. 人民币大写 ----------
    let lastRmb = '';
    function rmbRun() {
        const out = rmbConvert($('rmbIn').value);
        if (out === null) {
            lastRmb = '';
            $('rmbOut').classList.remove('hidden');
            $('rmbOut').innerHTML = '';
            row($('rmbOut'), '输入有误', ['请输入数字金额，如 12345.67']);
            showMessage('金额格式不正确', true);
            return;
        }
        lastRmb = out;
        showBox($('rmbOut'), [
            ['数字', [String($('rmbIn').value).trim()]],
            ['大写', [out]]
        ]);
        showMessage('转换完成');
    }

    $('rmbGo').addEventListener('click', rmbRun);
    $('rmbIn').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') rmbRun();
    });
    $('rmbEg').addEventListener('click', () => {
        $('rmbIn').value = '12345.67';
        rmbRun();
    });
    $('rmbCopy').addEventListener('click', () => {
        if (!lastRmb) { showMessage('还没有可复制的结果', true); return; }
        copyText(lastRmb);
    });
    $('rmbClear').addEventListener('click', () => {
        $('rmbIn').value = '';
        $('rmbOut').classList.add('hidden');
        $('rmbOut').innerHTML = '';
        lastRmb = '';
        showMessage('已清空');
    });

    // ---------- 2. 身份证校验 ----------
    let lastId = '';
    function idRun() {
        const r = idParse($('idIn').value);
        const box = $('idOut');
        box.classList.remove('hidden');
        box.innerHTML = '';
        if (!r.ok) {
            lastId = '';
            row(box, '校验失败', [r.reason]);
            showMessage('身份证号有误', true);
            return;
        }
        row(box, '校验码', r.checkOk ? ['通过'] : ['不通过，正确应为 ' + r.expect]);
        row(box, '地区', r.province);
        row(box, '出生日期', [r.birth, '星期']);
        row(box, '年龄 / 生肖', [r.age + ' 周岁', r.zodiac + '年']);
        row(box, '性别', r.sex);
        row(box, '星座', r.star);
        lastId = [
            '校验码：' + (r.checkOk ? '通过' : '不通过（应为 ' + r.expect + '）'),
            '地区：' + r.province,
            '出生日期：' + r.birth,
            '年龄：' + r.age + ' 周岁　生肖：' + r.zodiac,
            '性别：' + r.sex,
            '星座：' + r.star
        ].join('\n');
        showMessage(r.checkOk ? '校验通过' : '校验码不通过', !r.checkOk);
    }

    $('idGo').addEventListener('click', idRun);
    $('idIn').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') idRun();
    });
    $('idEg').addEventListener('click', () => {
        const base = '41010119900101123';            // 17 位示例前缀
        $('idIn').value = base + idCheckChar(base);   // 补上正确校验码
        idRun();
    });
    $('idCopy').addEventListener('click', () => {
        if (!lastId) { showMessage('还没有可复制的结果', true); return; }
        copyText(lastId);
    });
    $('idClear').addEventListener('click', () => {
        $('idIn').value = '';
        $('idOut').classList.add('hidden');
        $('idOut').innerHTML = '';
        lastId = '';
        showMessage('已清空');
    });

    // ---------- 3. 秒表 ----------
    let swRunning = false;
    let swElapsed = 0;
    let swBase = 0;
    let swTimer = null;
    const swLaps = [];

    function swNow() {
        return swElapsed + (swRunning ? performance.now() - swBase : 0);
    }
    function swPaint() {
        $('swTime').textContent = fmtStopwatch(swNow());
    }
    function swRenderLaps() {
        const box = $('swLaps');
        if (!swLaps.length) {
            box.classList.add('hidden');
            box.innerHTML = '';
            return;
        }
        box.classList.remove('hidden');
        box.innerHTML = '';
        swLaps.forEach((t, i) => {
            const diff = i === 0 ? t : t - swLaps[i - 1];
            row(box, '第 ' + (i + 1) + ' 次', [fmtStopwatch(t), '本段 +' + fmtStopwatch(diff)]);
        });
    }

    $('swStart').addEventListener('click', () => {
        if (swRunning) { showMessage('秒表已经在跑了', true); return; }
        swRunning = true;
        swBase = performance.now();
        swTimer = setInterval(swPaint, 31);
        showMessage('开始计时');
    });
    $('swStop').addEventListener('click', () => {
        if (!swRunning) { showMessage('秒表没有在运行', true); return; }
        swElapsed += performance.now() - swBase;
        swRunning = false;
        clearInterval(swTimer);
        swTimer = null;
        swPaint();
        showMessage('已停止');
    });
    $('swLap').addEventListener('click', () => {
        if (!swRunning) { showMessage('先开始计时才能计次', true); return; }
        swLaps.push(swNow());
        swRenderLaps();
    });
    $('swReset').addEventListener('click', () => {
        if (swTimer) clearInterval(swTimer);
        swTimer = null;
        swRunning = false;
        swElapsed = 0;
        swLaps.length = 0;
        swPaint();
        swRenderLaps();
        showMessage('已复位');
    });

    // ---------- 4. 倒计时 ----------
    let cdRunning = false;
    let cdRemain = 0;
    let cdEnd = 0;
    let cdTimer = null;

    function cdPaint() {
        $('cdTime').textContent = fmtCountdown(cdRemain);
    }
    function cdReadTotal() {
        const m = Math.max(0, Math.min(999, Math.round(readNum('cdMin') || 0)));
        const s = Math.max(0, Math.min(59, Math.round(readNum('cdSec') || 0)));
        return (m * 60 + s) * 1000;
    }
    function cdStopTimer() {
        if (cdTimer) clearInterval(cdTimer);
        cdTimer = null;
        cdRunning = false;
    }

    $('cdStart').addEventListener('click', () => {
        if (cdRunning) { showMessage('倒计时已经在跑了', true); return; }
        if (cdRemain <= 0) {
            cdRemain = cdReadTotal();
            if (cdRemain <= 0) { showMessage('请先设置大于 0 的时长', true); return; }
        }
        cdRunning = true;
        cdEnd = performance.now() + cdRemain;
        cdTimer = setInterval(() => {
            cdRemain = cdEnd - performance.now();
            if (cdRemain <= 0) {
                cdRemain = 0;
                cdStopTimer();
                cdPaint();
                showMessage('倒计时结束');
                cdBeep();
                return;
            }
            cdPaint();
        }, 200);
        cdPaint();
        showMessage('倒计时开始');
    });
    $('cdPause').addEventListener('click', () => {
        if (!cdRunning) { showMessage('倒计时没有在运行', true); return; }
        cdRemain = Math.max(0, cdEnd - performance.now());
        cdStopTimer();
        cdPaint();
        showMessage('已暂停');
    });
    $('cdReset').addEventListener('click', () => {
        cdStopTimer();
        cdRemain = cdReadTotal();
        cdPaint();
        showMessage('已复位');
    });
    ['cdMin', 'cdSec'].forEach((id) => {
        $(id).addEventListener('input', () => {
            if (cdRunning) return;      // 运行中不打断
            cdRemain = cdReadTotal();
            cdPaint();
        });
    });

    // ---------- 5. 月历 ----------
    function calRun() {
        const y = readNum('calY');
        const m = readNum('calM');
        if (y === null || m === null) { showMessage('请填写年份与月份', true); return; }
        if (calRender(Math.round(y), Math.round(m), $('calOut'))) showMessage('月历已生成');
    }
    function calToToday() {
        const now = new Date();
        $('calY').value = now.getFullYear();
        $('calM').value = now.getMonth() + 1;
        calRender(now.getFullYear(), now.getMonth() + 1, $('calOut'));
    }

    $('calGo').addEventListener('click', calRun);
    $('calToday').addEventListener('click', calToToday);
    calToToday();   // 默认展示本月

    // 从列表页锚点进入时，滚动到对应卡片
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
});
