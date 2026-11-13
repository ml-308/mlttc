// lib/ui/init.mjs
// ─── 全站 Web Components 注册入口 ──────────────
// 用法：每个页面在 <head> 里引入
//   <script src="/lib/ui/init.mjs" type="module"></script>
//
// 做两件事：
//   1. 拉取 /lib/ui/templates.html，把其中所有 <template> 注入到 body（供各组件克隆）
//   2. 定义自定义元素：hcw-modal-root / hcw-body-footer / hcw-flex /
//      hcw-button / hcw-input / hcw-textarea / hcw-hero / hcw-popup
// 并在 shadow 上挂共享的 wcStyleSheet（通用淡入动画 keyframes）。
//
// 关键约定（改样式前必读）：
//   - 每个自定义元素都开了 shadow DOM，视觉样式在 templates.html 的 shadow <style> 里；
//     文档 CSS 的 [hcw-button] / [hcw-input] 属性选择器**只匹配** <button hcw-button>
//     这类带属性元素，不匹配自定义元素宿主 → 改按钮/输入框外观必须改 templates.html。
//   - 宿主上的原始属性（表单属性、style 等）通过 Object.defineProperty 代理到 shadow 内部
//     真元素上，所以 <hcw-input placeholder="x"> 可直接 .placeholder / .value 读写。
//   - hcw-button / hcw-input / hcw-textarea 重写了 addEventListener / removeEventListener，
//     事件实际绑在内部元素上（外部拿不到内部节点也能正常监听）。
//   - hcw-button 带 href 属性时会自动接管点击并原地跳转（open(url, '_self')）。
//   - 本模块含顶层 await，必须用 type="module" 加载。
//
// 注意：CSS 变量可穿透 shadow DOM，所以改 colors/default.css 的 token 模板会同步跟着变。
import './popup.mjs';

let templatesCache = null;

/**
 * 拉取 templates.html，并把其中所有 <template> 注入 body（结果缓存，只真正执行一次）
 * @returns {Promise<boolean>} 是否加载成功；失败时静默返回 false（不影响页面其它功能）
 */
async function loadTemplates() {
    if (templatesCache) return templatesCache;

    try {
        const response = await fetch('/lib/ui/templates.html');
        const html = await response.text();

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const templates = doc.querySelectorAll('template');
        templates.forEach(template => {
            const importedTemplate = document.importNode(template, true);
            document.body.appendChild(importedTemplate);
        });

        templatesCache = true;
        return true;
    } catch (error) {
        return false;
    }
}

await loadTemplates();

const wcStyleSheet = new CSSStyleSheet();
wcStyleSheet.replaceSync(`
@keyframes general_fadeIn_nomove_fixed_noreplace_dontrestore {
    from { opacity: 0 }
    to { opacity: 1 }
}
@keyframes general_fadeIn_fixed_noreplace_dontrestore {
    from { opacity: 0; transform: translateY(.5rem) }
    to { opacity: 1; transform: translateY(0) }
}`);

class HcwModalRoot extends HTMLElement {
    #root;

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.adoptedStyleSheets.push(wcStyleSheet);
        shadow.appendChild(document.getElementById('template-hcw-modal-root').content.cloneNode(true));
        this.#root = shadow.querySelector('.modal-root');
    }

    get open() {
        return this.#root.getAttribute('open');
    }

    /**
     * @param {boolean} value 
     */
    set open(value) {
        return this.#root.setAttribute('open', value);
    }
}

class HcwBodyFooter extends HTMLElement {
    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.adoptedStyleSheets.push(wcStyleSheet);
        shadow.appendChild(document.getElementById('template-hcw-footer').content.cloneNode(true));
    }
}

class HcwFlex extends HTMLElement {
    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.adoptedStyleSheets.push(wcStyleSheet);
        shadow.appendChild(document.getElementById('template-hcw-flex').content.cloneNode(true));
    }
}

class HcwButton extends HTMLElement {
    #button;

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.adoptedStyleSheets.push(wcStyleSheet);
        shadow.appendChild(document.getElementById('template-hcw-button').content.cloneNode(true));
        this.#button = shadow.querySelector('.inner-root');

        if (this.hasAttribute('href')) {
            this.addEventListener('click', () => {
                open(this.getAttribute('href'), '_self');
            });
        }
        const raw_props = ['style', 'onclick'];
        raw_props.forEach(prop => {
            Object.defineProperty(this, prop, {
                get: () => this.#button[prop],
                set: (val) => this.#button[prop] = val,
                enumerable: true,
                configurable: true
            })
            this[prop] = this.getAttribute(prop);
        });
    }
}

class HcwInput extends HTMLElement {
    #input;
    #label;

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.adoptedStyleSheets.push(wcStyleSheet);
        shadow.appendChild(document.getElementById('template-hcw-input').content.cloneNode(true));
        this.#input = shadow.querySelector('input');
        this.#label = shadow.querySelector('label');
        this.#syncLabel();

        const raw_props = ['accept', 'checked', 'formaction', 'max', 'maxlength', 'min', 'minlength', 'step', 'name', 'type', 'value', 'placeholder', 'disabled', 'type', 'autocapitalize', 'style', 'onchange'];
        const dom_props = ['required', 'alt', 'readonly', 'autocomplete'];
        raw_props.forEach(prop => {
            Object.defineProperty(this, prop, {
                get: () => this.#input[prop],
                set: (val) => this.#input[prop] = val,
                enumerable: true,
                configurable: true
            })
            this[prop] = this.getAttribute(prop);
        });
        dom_props.forEach(prop => {
            Object.defineProperty(this, prop, {
                get: () => this.#input.getAttribute(prop),
                set: (val) => this.#input[val === undefined ? 'removeAttribute' : 'setAttribute'](prop, val),
                enumerable: true,
                configurable: true
            });
            // this[prop] = this.getAttribute(prop);
        });
    }

    /** 标签文本：构造之后再改 label 属性也要生效（弹窗里 showPrompt 是后设的） */
    get label() {
        return this.getAttribute('label') ?? '';
    }

    set label(value) {
        if (value === null || value === undefined || value === '') this.removeAttribute('label');
        else this.setAttribute('label', String(value));
        this.#syncLabel();
    }

    /** 与改造前一致：label 允许带简单标记，原样写进 shadow 里的 <label> */
    #syncLabel() {
        this.#label.innerHTML = this.label;
    }

    /** 让调用方把焦点送进 shadow 里的真输入框（showPrompt 打开即聚焦） */
    focus(options) {
        this.#input.focus(options);
    }

    blur() {
        this.#input.blur();
    }

    addEventListener(...args) {
        this.#input.addEventListener(...args);
    }

    removeEventListener(...args) {
        this.#input.removeEventListener(...args);
    }
}

class HcwTextarea extends HTMLElement {
    #input;
    #label;

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.adoptedStyleSheets.push(wcStyleSheet);
        shadow.appendChild(document.getElementById('template-hcw-textarea').content.cloneNode(true));
        this.#input = shadow.querySelector('textarea');
        this.#label = shadow.querySelector('label');
        this.#syncLabel();

        const raw_props = ['name', 'value', 'placeholder', 'disabled', 'required', 'onchange'];
        const dom_props = ['readonly', 'style'];
        raw_props.forEach(prop => {
            Object.defineProperty(this, prop, {
                get: () => this.#input[prop],
                set: (val) => this.#input[prop] = val,
                enumerable: true,
                configurable: true
            });
            // this[prop] = this.getAttribute(prop);
        });
        dom_props.forEach(prop => {
            Object.defineProperty(this, prop, {
                get: () => this.#input.getAttribute(prop),
                set: (val) => this.#input[val === undefined ? 'removeAttribute' : 'setAttribute'](prop, val),
                enumerable: true,
                configurable: true
            });
            // this[prop] = this.getAttribute(prop);
        });
    }

    /** 同 HcwInput：标签支持后设 */
    get label() {
        return this.getAttribute('label') ?? '';
    }

    set label(value) {
        if (value === null || value === undefined || value === '') this.removeAttribute('label');
        else this.setAttribute('label', String(value));
        this.#syncLabel();
    }

    #syncLabel() {
        this.#label.innerHTML = this.label;
    }

    focus(options) {
        this.#input.focus(options);
    }

    blur() {
        this.#input.blur();
    }

    addEventListener(...args) {
        this.#input.addEventListener(...args);
    }

    removeEventListener(...args) {
        this.#input.removeEventListener(...args);
    }
}

class HcwHero extends HTMLElement {
    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.appendChild(document.getElementById('template-hcw-hero').content.cloneNode(true));
    }
}

class HcwPopup extends HTMLElement {
    #root;
    #modalRoot;
    #header;
    #dismissible = true;
    #onKeydown = (event) => {
        if (event.key === 'Escape') this.#requestDismiss('escape');
    };
    contentNode;
    contentSlot;
    titleNode;
    eyebrowNode;
    btnGroupNode;
    closeNode;

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.appendChild(document.getElementById('template-hcw-popup').content.cloneNode(true));
        this.#root = shadow.querySelector('.inner-root');
        this.#header = shadow.querySelector('.header');
        this.#modalRoot = shadow.querySelector('hcw-modal-root');
        this.contentNode = shadow.querySelector('[name="text"]');
        this.contentSlot = shadow.querySelector('[name="content"]');
        this.titleNode = shadow.querySelector('[name="title"]');
        this.eyebrowNode = shadow.querySelector('[name="eyebrow"]');
        this.btnGroupNode = shadow.querySelector('[name="btn-group"]');
        this.closeNode = shadow.querySelector('[name="close"]');
        this.closeNode.hidden = !this.#dismissible;

        this.closeNode.addEventListener('click', () => this.#requestDismiss('close'));

        // 点遮罩关闭：按下与抬起都落在遮罩上才算，避免从卡片里拖选文字滑出去时误关
        let pressingBackdrop = false;
        this.#modalRoot.addEventListener('pointerdown', (event) => {
            pressingBackdrop = event.target === this.#modalRoot;
        });
        this.#modalRoot.addEventListener('click', (event) => {
            if (pressingBackdrop && event.target === this.#modalRoot) this.#requestDismiss('backdrop');
            pressingBackdrop = false;
        });

        this.#syncChrome();
    }

    /** 关窗信号的统一出口：showPrompt / showConfirm 监听这个事件来收尾 */
    #requestDismiss(source) {
        if (!this.#dismissible || this.open !== 'true') return;
        this.dispatchEvent(new CustomEvent('dismiss', { detail: { source } }));
    }

    /** 标题/描述/关闭钮的显隐跟文本同步：空文本不留空白行，也不让读屏读到空标题 */
    #syncChrome() {
        const title = this.titleNode.textContent.trim();
        const text = this.contentNode.textContent.trim();
        const eyebrow = this.eyebrowNode.textContent.trim();
        this.titleNode.hidden = !title;
        this.contentNode.hidden = !text;
        this.eyebrowNode.hidden = !eyebrow;
        this.#header.hidden = !(title || text || eyebrow);
        this.#root.setAttribute('aria-label', title || text || '对话框');
    }

    get title() {
        return this.titleNode.textContent;
    }

    set title(value) {
        this.titleNode.textContent = value ?? '';
        this.#syncChrome();
    }

    get eyebrow() {
        return this.eyebrowNode.textContent;
    }

    set eyebrow(value) {
        this.eyebrowNode.textContent = value ?? '';
        this.#syncChrome();
    }

    get text() {
        return this.contentNode.textContent;
    }

    set text(value) {
        this.contentNode.textContent = value ?? '';
        this.#syncChrome();
    }

    get dismissible() {
        return this.#dismissible;
    }

    set dismissible(value) {
        this.#dismissible = Boolean(value);
        this.closeNode.hidden = !this.#dismissible;
    }

    get open() {
        return this.#modalRoot.open;
    }

    set open(value) {
        const next = value === true || value === 'true';
        const wasOpen = this.open === 'true';
        this.#modalRoot.open = next;
        if (!next) {
            document.removeEventListener('keydown', this.#onKeydown);
            return;
        }
        if (!wasOpen) {
            document.addEventListener('keydown', this.#onKeydown);
            // 焦点落进弹窗：输入变体会在 showPrompt 里再聚焦到输入框
            requestAnimationFrame(() => {
                if (!this.shadowRoot.activeElement) this.#root.focus({ preventScroll: true });
            });
        }
    }
}

customElements.define('hcw-modal-root', HcwModalRoot);
customElements.define('hcw-body-footer', HcwBodyFooter);
customElements.define('hcw-flex', HcwFlex);
customElements.define('hcw-button', HcwButton);
customElements.define('hcw-input', HcwInput);
customElements.define('hcw-textarea', HcwTextarea);
customElements.define('hcw-hero', HcwHero);
customElements.define('hcw-popup', HcwPopup);