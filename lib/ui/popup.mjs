// lib/ui/popup.mjs
// ─── 基于 <hcw-popup> 的命令式弹窗 ───────────────────────
// 由 lib/ui/init.mjs 首行 import → 引入 init.mjs 的页面都能用。
//
// 导出：
//   showConfirm({ title, text, eyebrow, buttons, button_style, dismissible }) → Promise<number>
//       返回值是**倒序**索引：默认按钮 ['确定','取消'] 时，
//       点「确定」得到 1，点「取消」得到 0（4 个按钮则依次为 3/2/1/0）。
//       点 × / 按 Esc / 点遮罩与点最后一个按钮同值（默认即「取消」）。
//   showPrompt({ title, text, label, buttons, button_style, input_is_area, input_attrs, dismissible }) → Promise<string|null>
//       点最后一个按钮 / 关闭弹窗 → null；否则 → 输入框的值。
//       input_is_area 为真时用 hcw-textarea，input_attrs 会逐项赋到输入控件上。
//   showDialog({ title, text, eyebrow, content, buttons, button_style, dismissible }) → Promise<number|null>
//       通用原语：同上返回倒序索引；content 可挂任意节点（如更新提示的版本对比块）。
//   popupReady(timeoutMs) → Promise<boolean>
//       <hcw-popup> 是否可用（页面没引 init.mjs 时用它决定降级方案）。
//
// 标题与正文的分工：同时给 title 和 text 时 text 是正文；只给 text 时它自己就是标题
// （单句确认不需要再被压成灰色小字，样式由 templates.html 的
//  .header:not(:has(.title:not([hidden]))) .text 兜底）。
//
// 依赖：页面必须先加载 init.mjs，否则 <hcw-popup> 未定义，弹窗不会渲染。
// 交互：右上角 ×、Esc、点遮罩都能关；dismissible 为 false 时这三种方式全部禁用。
// 实现细节：关闭时先 modal.open = false，250ms 后才 remove()，等关闭动画播完。
// ⚠️ 判断用户意图要看 showConfirm 的**返回值**，不要靠按钮文案（buttons 可自定义）。

/** 关闭动画时长（ms），与 templates.html 里 modal-root 的 0.25s 对齐 */
const CLOSE_ANIM_MS = 250;

/**
 * 等 <hcw-popup> 就绪：组件库（init.mjs）可能还没执行完，此时 createElement 拿到的是
 * 未升级的未知元素，btnGroupNode 是 undefined，后面写 innerHTML 会直接抛错、弹窗静默消失。
 * 页面压根没引 init.mjs 时 whenDefined 永远不 resolve，所以带超时兜底。
 * @returns {Promise<boolean>} 组件可用返回 true
 */
export async function popupReady(timeoutMs = 1500) {
    if (customElements.get('hcw-popup')) return true;
    return Promise.race([
        customElements.whenDefined('hcw-popup').then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(Boolean(customElements.get('hcw-popup'))), timeoutMs)),
    ]);
}

/** 只给 text 时它就是标题；title 与 text 同时给时才分成「标题 + 正文」 */
function resolveCopy({ title = '', text = '' }) {
    if (!title && text) return { title: text, text: '' };
    return { title, text };
}

/** 记下打开前的焦点，关闭后还回去：键盘用户不会因为一次弹窗掉回页首 */
function rememberFocus() {
    const previous = document.activeElement;
    return () => {
        if (previous && typeof previous.focus === 'function' && previous.isConnected) {
            previous.focus({ preventScroll: true });
        }
    };
}

/**
 * 挂载弹窗并接线。返回的 promise 解析为按钮的**倒序**索引；
 * 关闭（× / Esc / 遮罩）按最后一个按钮计，调用方的取消分支不用另写一套。
 */
function mountDialog({ title, text, eyebrow, content, buttons, button_style, dismissible }) {
    const modal = document.createElement('hcw-popup');
    modal.title = title;
    modal.text = text;
    modal.eyebrow = eyebrow;
    modal.dismissible = dismissible;
    modal.btnGroupNode.innerHTML = buttons
        .map((label, i) => '<hcw-button ' + (button_style[i] ?? '') + '>' + label + '</hcw-button>')
        .join('');

    const { promise, resolve } = Promise.withResolvers();
    let settled = false;
    const finish = (index) => {
        if (settled) return;
        settled = true;
        modal.open = false;
        setTimeout(() => modal.remove(), CLOSE_ANIM_MS);
        resolve(index);
    };

    if (content) modal.contentSlot.appendChild(content);

    modal.btnGroupNode.childNodes.forEach((el, i, all) => {
        el.addEventListener('click', () => finish(all.length - i - 1));
    });

    modal.addEventListener('dismiss', () => finish(0));

    document.body.appendChild(modal);
    modal.open = true;

    return { modal, promise, finish };
}

/**
 * 通用对话框：按钮倒序索引；组件库不可用时返回 null（调用方自行降级）。
 * content 可以是任意节点，会被挂进弹窗的正文内容区（输入控件、版本对比块等）。
 */
export async function showDialog({
    title = '',
    text = '',
    eyebrow = '',
    content = null,
    buttons = ['确定', '取消'],
    button_style = ['primary', ''],
    dismissible = true,
} = {}) {
    if (!(await popupReady())) return null;
    const restoreFocus = rememberFocus();
    const { promise } = mountDialog({
        ...resolveCopy({ title, text }),
        eyebrow,
        content,
        buttons,
        button_style,
        dismissible,
    });
    const index = await promise;
    restoreFocus();
    return index;
}

/**
 * 确认框
 * @param {object} param0 buttons 为按钮文本数组, button_style 为按钮样式数组(直接注入到 HTML 标签)
 * @returns {number} 代表点击的按钮的**倒序**索引，如对于默认的 '确定' '取消'，点击 '确定' 返回 1, 点击 '取消' 返回 0
 */
export async function showConfirm({
    text = '确定要进行该操作吗？',
    title = '',
    eyebrow = '',
    buttons = ['确定', '取消'],
    button_style = ['primary', ''],
    dismissible = true,
} = {}) {
    if (!(await popupReady())) {
        // 组件库不可用 → 退回浏览器原生确认框，至少不会静默失败（返回值语义保持一致）
        return confirm(text) ? buttons.length - 1 : 0;
    }
    const restoreFocus = rememberFocus();
    const { promise } = mountDialog({
        ...resolveCopy({ title, text }),
        eyebrow,
        buttons,
        button_style,
        dismissible,
    });
    const index = await promise;
    restoreFocus();
    return index;
}

/**
 * 输入框弹窗
 * @param {object} param0 buttons 为按钮文本数组, button_style 为按钮样式数组(直接注入到 HTML 标签)
 * @returns {string|null} 输入的值。若点击的按钮是最后一个（或直接关窗），返回 null, 否则返回输入的值。
 */
export async function showPrompt({
    text = '输入：',
    title = '',
    eyebrow = '',
    label = '',
    buttons = ['确定', '取消'],
    button_style = ['primary', ''],
    input_is_area = false,
    input_attrs = { placeholder: '占位' },
    dismissible = true,
} = {}) {
    if (!(await popupReady())) {
        // 组件库不可用 → 退回浏览器原生输入框（点取消返回 null，与下面的语义一致）
        return prompt(title || text, input_attrs.placeholder ?? '');
    }

    const restoreFocus = rememberFocus();
    const { modal, promise, finish } = mountDialog({
        ...resolveCopy({ title, text }),
        eyebrow,
        buttons,
        button_style,
        dismissible,
    });

    const input = document.createElement(input_is_area ? 'hcw-textarea' : 'hcw-input');
    if (label) input.label = label;
    Object.entries(input_attrs).forEach(([key, value]) => {
        input[key] = value;
    });
    // 输入控件挂在弹窗的正文内容区，不再塞进标题节点
    modal.contentSlot.appendChild(input);

    // 单行输入按回车 = 点「确定」；中文输入法选词时也按回车，必须放过（isComposing）
    if (!input_is_area) {
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.isComposing) return;
            event.preventDefault();
            finish(buttons.length - 1);
        });
    }

    // 打开就把焦点放进输入框：弹窗只为一件事而来，键盘用户不用再 Tab 一次
    requestAnimationFrame(() => input.focus());

    const index = await promise;
    restoreFocus();
    return index ? input.value : null;
}
