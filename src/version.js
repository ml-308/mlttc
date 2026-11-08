// src/version.js
/**
 * 站点当前版本号（单一真相源）
 *
 * 前端所有需要展示版本号的地方，统一从这里读取；
 * 「检查新版本」功能（src/version-check.js）也以此作为「当前已运行版本」，
 * 与后端 /api/version 返回的最新版本号对比。
 *
 * 发版时改这一处即可（index.html 等展示位会自动跟随）。
 */
export const APP_VERSION = '1.2.8';
