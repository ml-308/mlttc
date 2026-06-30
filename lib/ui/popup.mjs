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