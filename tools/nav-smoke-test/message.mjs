// tools/nav-smoke-test/message.mjs —— 仅用于冒烟测试的替代实现
export const calls = [];
export function showMessage(text, isError) { calls.push([text, !!isError]); }
