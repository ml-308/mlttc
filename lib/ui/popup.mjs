// lib/ui/popup.mjs
// ─── 基于 <hcw-popup> 的命令式弹窗 ───────────────────────
// 由 lib/ui/init.mjs 首行 import → 引入 init.mjs 的页面都能用。
//
// 导出：
//   showConfirm({ text, buttons, button_style }) → Promise<number>
//       返回值是**倒序**索引：默认按钮 ['确定','取消'] 时，
//       点「确定」得到 1，点「取消」得到 0（4 个按钮则依次为 3/2/1/0）
//   showPrompt({ text, buttons, button_style, input_is_area, input_attrs }) → Promise<string|null>
//       点最后一个按钮 → null；否则 → 输入框的值。
//       input_is_area 为真时用 hcw-textarea，input_attrs 会逐项赋到输入控件上。
//
// 依赖：页面必须先加载 init.mjs，否则 <hcw-popup> 未定义，弹窗不会渲染。
// 实现细节：关闭时先 modal.open = false，250ms 后才 remove()，等关闭动画播完。
// ⚠️ 判断用户意图要看 showConfirm 的**返回值**，不要靠按钮文案（buttons 可自定义）。

/**
 * 
 * @param {object} param0 `buttons` 为按钮文本数组, `button_style` 为按钮样式数组(直接注入到HTML标签)
 * @returns {number} 代表点击的按钮的**倒序**索引，如对于默认的 '确定' '取消'，点击 '确定' 返回 1, 点击 '取消' 返回 0
 * 
 */
export async function showConfirm({ text = '确定要进行该操作吗？', buttons = ['确定', '取消'], button_style = ['primary', ''] } = {}) {
    const { promise, resolve } = Promise.withResolvers();
    const modal = document.createElement('hcw-popup');
    modal.text = text;
    modal.btnGroupNode.innerHTML = `${buttons.map((v, i) => `<hcw-button ${button_style[i] ?? ''}>${v}</hcw-button>`).join('')}`;
    modal.btnGroupNode.childNodes.forEach((el, i, a) => {
        el.addEventListener('click', () => {
            modal.open = false;
            setTimeout(() => modal.remove(), 250);
            resolve(a.length - i - 1);
        })
    });
    document.body.appendChild(modal);
    modal.open = true;
    return promise;
}

/**
 * 
 * @param {object} param0 `buttons` 为按钮文本数组, `button_style` 为按钮样式数组(直接注入到HTML标签)
 * @returns {number} 输入的值。若点击的按钮是最后一个，那么返回 null, 否则返回输入的值。
 * 
 */
export async function showPrompt({ text = '输入：', buttons = ['确定', '取消'], button_style = ['primary', ''], input_is_area = false, input_attrs = { placeholder: '占位' } } = {}) {
    const { promise, resolve } = Promise.withResolvers();
    const modal = document.createElement('hcw-popup');
    modal.text = text;

    const input = document.createElement(input_is_area ? 'hcw-textarea' : 'hcw-input');
    Object.entries(input_attrs).forEach(([k, v]) => {
        input[k] = v;
    });
    modal.contentNode.appendChild(input);

    modal.btnGroupNode.innerHTML = `${buttons.map((v, i) => `<hcw-button ${button_style[i] ?? ''}>${v}</hcw-button>`).join('')}`;
    modal.btnGroupNode.childNodes.forEach((el, i, a) => {
        el.addEventListener('click', () => {
            modal.open = false;
            setTimeout(() => modal.remove(), 250);
            if (a.length - i - 1) {
                resolve(input.value);
            } else {
                resolve(null);
            }
        })
    });
    document.body.appendChild(modal);
    modal.open = true;
    return promise;
}

// document.addEventListener('DOMContentLoaded', () => {
//     document.getElementById('check-confirm').addEventListener('click', async () => {
//         const value = await showPrompt({ input_is_area: true, input_attrs: { readonly: true } });
//         alert(value);

//         if (await showConfirm()) {
//             alert('Clicked');
//         }
//     });
// })