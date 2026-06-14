// 页面跳转函数
function timetable() {
  window.location.href = 'timetable.html';
}

function register_btn() {
  window.location.href = 'register.html';
}

// ==================== 页面跳转函数 ====================
function back() {
  window.location.href = 'index.html';
}



// 暴露到全局，供 HTML 中 onclick 直接调用
window.back = back;

// ==================== 初始化 ====================
window.addEventListener('DOMContentLoaded', () => {
  // login.js 已在内部自动调用 checkLoginStatus 恢复登录界面，
  // 此处无需重复调用，仅保留入口用于其他可能的初始化操作。
});

// 暴露全局（虽然内联 onclick 可以直接调用，这里显式挂载以保持统一）
window.timetable = timetable;
window.register_btn = register_btn;