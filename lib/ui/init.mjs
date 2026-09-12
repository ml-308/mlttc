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

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.adoptedStyleSheets.push(wcStyleSheet);
        shadow.appendChild(document.getElementById('template-hcw-input').content.cloneNode(true));
        this.#input = shadow.querySelector('input');

        if (this.hasAttribute('label')) {
            shadow.querySelector('label').innerHTML = this.getAttribute('label');
        }

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

    addEventListener(...args) {
        this.#input.addEventListener(...args);
    }

    removeEventListener(...args) {
        this.#input.removeEventListener(...args);
    }
}

class HcwTextarea extends HTMLElement {
    #input;

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.adoptedStyleSheets.push(wcStyleSheet);
        shadow.appendChild(document.getElementById('template-hcw-textarea').content.cloneNode(true));
        this.#input = shadow.querySelector('textarea');

        if (this.hasAttribute('label')) {
            shadow.querySelector('label').innerHTML = this.getAttribute('label');
        }

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
    contentNode;
    btnGroupNode;

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.appendChild(document.getElementById('template-hcw-popup').content.cloneNode(true));
        this.#root = shadow.querySelector('.inner-root');
        this.contentNode = shadow.querySelector('[name="text"]');
        this.btnGroupNode = shadow.querySelector('[name="btn-group"]');
        this.#modalRoot = shadow.querySelector('hcw-modal-root');
    }

    get text() {
        return this.contentNode.textContent;
    }

    set text(value) {
        this.contentNode.textContent = value;
    }

    get open() {
        return this.#modalRoot.open;
    }

    set open(value) {
        this.#modalRoot.open = value;
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