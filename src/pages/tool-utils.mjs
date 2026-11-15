// src/pages/tool-utils.mjs
/**
 * 工具页共用的小工具函数（/tool-*.html 五个页面共享）
 *
 * 依赖：无（纯浏览器 API）
 */

/**
 * 用 id 取元素的简写
 * @param {string} id
 * @returns {HTMLElement|null}
 */
export const $ = (id) => document.getElementById(id);

/**
 * 给 id 对应的元素绑定事件：元素不存在时只打警告，不抛错。
 *
 * 为什么需要它：工具页把多个子工具都写在一个 DOMContentLoaded 回调里，
 * 只要有一个 `$('x').addEventListener` 拿到 null 就会抛 TypeError，
 * 回调就此中断 —— 后面所有子工具的事件一个都绑不上，界面上表现为
 * 「有的工具正常、有的工具点了没反应」，而且控制台里没有任何提示。
 * （现实例子：tool-life 的身份证卡片被删掉后，秒表 / 倒计时 / 月历全部失效）
 * @param {string} id
 * @param {string} type 事件名
 * @param {(e: Event) => void} handler
 * @returns {boolean} 是否绑定成功
 */
export function on(id, type, handler) {
    const el = $(id);
    if (!el) {
        console.warn('[tool-utils] 页面缺少元素 #' + id + '，已跳过它的「' + type + '」事件绑定');
        return false;
    }
    el.addEventListener(type, handler);
    return true;
}

/**
 * 把文本按行拆开（兼容 \r\n / \r / \n），并去掉结尾空行造成的空数组项
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
    return text.split(/\r\n|\r|\n/);
}

/**
 * 复制文本到剪贴板：优先 Clipboard API，失败时回退到临时 textarea + execCommand
 * （http / 非安全上下文下 navigator.clipboard 不可用，必须有回退）
 * @param {string} text
 * @returns {Promise<boolean>} 是否复制成功
 */
export async function copyText(text) {
    if (!text) {
        const { showMessage } = await import('/lib/ui/message.mjs');
        showMessage('没有可复制的内容', true);
        return false;
    }
    try {
        await navigator.clipboard.writeText(text);
        const { showMessage } = await import('/lib/ui/message.mjs');
        showMessage('已复制到剪贴板');
        return true;
    } catch (err) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch (e) {
            // 回退方案本身也失败：留一条可诊断的日志，而不是静默吞掉
            console.warn('[tool-utils] execCommand("copy") 执行失败：', e);
            ok = false;
        }
        ta.remove();
        const { showMessage } = await import('/lib/ui/message.mjs');
        showMessage(ok ? '已复制到剪贴板' : '复制失败，请手动选择复制', !ok);
        return ok;
    }
}

/**
 * 数字显示格式化：避免浮点噪声（0.1+0.2），过小/过大改用科学计数法
 * @param {number} n
 * @returns {string}
 */
export function formatNumber(n) {
    if (!isFinite(n)) return '—';
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs < 1e-6 || abs >= 1e15) return n.toExponential(6);
    return String(parseFloat(n.toPrecision(12)));
}
