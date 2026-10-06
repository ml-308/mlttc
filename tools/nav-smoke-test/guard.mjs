// tools/nav-smoke-test/guard.mjs —— 仅用于冒烟测试的替代实现
export function createGuard(msg) {
  let busy = false;
  return { msg, async run(fn) { if (busy) return; try { return await fn(); } finally { busy = false; } } };
}
