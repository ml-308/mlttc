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
