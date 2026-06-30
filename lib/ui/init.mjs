import { a } from "./elementring.mjs";
import './popup.mjs';

let templatesCache = null;

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

/**
 * 
 * @param {string} id 
 * @returns {HTMLTemplateElement}
 */
function getTemplate(id) {
    const template = document.getElementById(id);
    if (!template) {
        return null;
    }
    return template.content.cloneNode(true);
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