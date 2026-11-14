// src/version.js
/**
 * 站点当前版本号（单一真相源）
 *
 * 前端所有需要展示版本号的地方，统一从这里读取；
 * 「检查新版本」功能（src/version-check.js）也以此作为「当前已运行版本」，
 * 与部署标记（lib/data/changelog.json 的 latestVersion）对比。
 *
 * 发版时改这一处即可；index.html 的静态兜底文案与 lib/data/changelog.json 的
 * latestVersion 都是它的副本（前者防 JS 未执行，后者由 tools/gen-changelog.mjs 生成）。
 */
export const APP_VERSION = '1.6.2';
