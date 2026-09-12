// lib/ui/guard.mjs
/**
 * 防重复提交守卫
 *
 * 解决的问题：用户连点「注册 / 登录 / 保存 / 提交」按钮时，会发出多个写请求。
 * 后果有两个 —— 可能重复写入数据，还很容易把用户自己顶到服务端的频率限制上
 * （返回 429），于是本该成功的操作变成一句「请求过于频繁」。
 *
 * 用法：
 *   import { createGuard } from '/lib/ui/guard.mjs';
 *   const saveGuard = createGuard('正在保存，请稍候…');
 *
 *   button.addEventListener('click', () => saveGuard.run(async () => {
 *     ...真正的提交逻辑...
 *   }));
 *
 * 行为：
 *   - 执行期间再次触发 → 直接忽略，并给一条浅色提示（不是错误，只是提醒）
 *   - 无论成功、失败还是抛异常，结束后自动解除（finally）
 */

import { showMessage } from './message.mjs';

/**
 * 创建一个守卫实例
 *
 * @param {string} [pendingMessage='正在处理中，请稍候…'] 重复触发时的提示文案
 * @returns {{ busy: boolean, run: <T>(action: () => Promise<T>) => Promise<T|undefined> }}
 */
export function createGuard(pendingMessage = '正在处理中，请稍候…') {
    let busy = false;

    return {
        /** 当前是否有动作正在执行（便于测试断言） */
        get busy() {
            return busy;
        },

        /**
         * 执行一个动作；若上一次还没结束，则忽略本次调用
         *
         * @template T
         * @param {() => Promise<T>} action
         * @returns {Promise<T|undefined>} 被忽略时返回 undefined
         */
        async run(action) {
            if (busy) {
                showMessage(pendingMessage, false, { type: 'info' });
                return undefined;
            }

            busy = true;
            try {
                return await action();
            } finally {
                busy = false;
            }
        }
    };
}
