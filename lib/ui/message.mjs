// lib/ui/message.mjs
/**
 * 全站统一的消息提示（顶部浮动 Toast）
 *
 * 用法：
 *   import { showMessage } from '/lib/ui/message.mjs';
 *
 *   showMessage('保存成功');                    // 成功（绿）
 *   showMessage('保存失败', true);              // 失败（红）
 *   showMessage('正在处理…', false, { type: 'info' });   // 信息（蓝）
 *
 * 设计说明：
 *   - 用 class（.notification-popup / -success / -error / -info）而不是内联样式，
 *     颜色、圆角、磨砂背景统一走 style/main.css 的设计令牌，能跟随深浅色主题。
 *   - 动画与停留时长保持一致（CSS 的 notificationSlide 为 2.5s）。
 *
 * 历史上这段代码在 10 个页面脚本里各抄了一份，且三份已经各自演化
 * （有的漏了 transform: translateX(-50%) 导致弹窗偏右、有的 2s 有的 2.5s、
 *   有的去更新一个全站都不存在的 #errormsg 元素）。现统一为一份。
 */

/** 默认停留时长（ms），与 CSS 中 notificationSlide 动画时长对齐 */
const DEFAULT_DURATION = 2500;

/** 允许的提示类型 */
const KINDS = ['success', 'error', 'info'];

/**
 * 显示一条浮动消息提示
 *
 * @param {string} msg                 提示文本
 * @param {boolean} [isError=false]    true = 失败（红），false = 成功（绿）
 * @param {object} [options]
 * @param {'success'|'error'|'info'} [options.type]  显式指定类型，优先级高于 isError
 * @param {number} [options.duration]  停留时长（ms），默认 2500
 * @returns {HTMLElement} 生成的提示元素（便于测试或手动移除）
 */
export function showMessage(msg, isError = false, options = {}) {
    const { type, duration = DEFAULT_DURATION } = options;
    const kind = KINDS.includes(type) ? type : (isError ? 'error' : 'success');

    const popup = document.createElement('div');
    popup.className = `notification-popup notification-${kind}`;
    popup.setAttribute('role', 'status');
    popup.setAttribute('aria-live', 'polite');
    popup.textContent = msg;

    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), duration);

    return popup;
}

export default showMessage;
