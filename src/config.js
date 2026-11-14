// src/config.js
/**
 * 站点前端配置（只放可以公开给浏览器的常量，任何密钥都不要写在这里）
 *
 * TURNSTILE_SITE_KEY —— Cloudflare Turnstile 人机验证的 site key（公开值）
 *   - 留空 = 不启用：不加载第三方脚本、不渲染组件、提交时也不带 turnstileToken（后端此时放行）
 *   - 填入 site key 后：登录框（/src/pages/main.js）与注册页（/src/pages/register.js）
 *     会自动加载 Turnstile 并生效
 *   - secret 配置在 Cloudflare 环境变量 TURNSTILE_SECRET，由 /functions 下的接口校验，
 *     不会、也不应该出现在前端
 */

/** Turnstile site key；留空表示不启用 */
export const TURNSTILE_SITE_KEY = '0x4AAAAAAGARTT6NfsxGB-6x';
