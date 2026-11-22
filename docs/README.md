# docs

站点代码之外的参考资料，**不参与部署**。站点运行时代码仍在根目录的 `*.html` 与
`asset/ functions/ lib/ src/ style/`。

| 文件 | 用途 |
| --- | --- |
| `KD一对A-网站页面布局-内容总结.md` | UP 主「KD一对A」22 条界面科普视频的总结，含第四节「可直接抄走的验收单」。`style/` 与 `lib/ui/` 里的字号档位、按钮六态、触控热区、下拉高度、圆角与色阶规则都以这份验收单为准。 |
| `县级市与自治县比对.txt` | `lib/data/cities.json` 与 province-city-china 区划表的比对报告，数据维护时参考。 |

## 界面实现约定（验收单落到代码里的样子）

改样式前先看这里，避免把已经收敛过的规则又写散：

1. **字号只用 4 档**：`--text-display` 44 / `--text-title` 22 / `--text-body` 15 /
   `--text-caption` 12（定义在 `style/main.css` 的 `:root`）。新页面不要再写裸 `px/rem`，
   也不要引入第 5 档。
2. **颜色只从 token 取**：文字 / 数字用绿色时用 `--primary-ink`（亮绿 `--primary` 是填充色，
   当文字只有 ~2:1）；橙色文字用 `--warning-ink`。层次靠 `--bg-page → --bg-card → --bg-hover`
   的 1%–3% 明度差，不写纯黑、不写粗黑边框。
   **不要再手写绿值**：`--primary-ink` / `--link-color` / `--on-primary` 会跟着用户自定义主题色
   由 `src/auth-header.js` 现算（浅色主题压暗、深色主题提亮，保证 ≥4.5:1），画布类页面从
   `--primary` 读数或按 `color-mix(in srgb, var(--primary) …)` 派生。
3. **按钮六态齐全**：默认 / 悬停 / 按下（下沉 1px）/ 禁用 / 加载 `[loading]` / 焦点
   `:focus-visible`。提交类按钮统一 `createGuard(msg).run(action, button)`，
   守卫会自动挂 `loading + disabled + aria-busy`。
   **不要给按钮加 `text-box: trim-both cap alphabetic`**：中文字体的 cap 高远小于汉字实际高度，
   裁到 cap/baseline 会把中文整体顶上去，胶囊里明显偏上；中文页面的垂直居中交给 flex 即可。
4. **热区**：`--touch-target` 40px 是底线，主操作 `--touch-target-lg` 44px；图标可以在视觉上
   只有 16px，但宿主热区不能小于 40×40。
5. **圆角与阴影**：卡片 / 弹窗用 `corner-shape: squircle`；卡片只给 `--shadow-xs/-sm`，
   `--shadow-lg/-xl` 只留给真正浮在页面上的浮层（弹窗、下拉、Toast）。
6. **下拉面板**最高 `16.5rem`（264px ≈ 8 行），候选由选择器输入框本身过滤；
   输入框与按钮高度不低于 44 / 40px。

