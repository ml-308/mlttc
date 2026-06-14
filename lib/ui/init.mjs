import { a } from "./elementring.mjs";

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

        const raw_props = ['value', 'placeholder', 'disabled', 'type', 'required', 'autocomplete', 'style', 'onchange'];
        raw_props.forEach(prop => {
            Object.defineProperty(this, prop, {
                get: () => this.#input[prop],
                set: (val) => this.#input[prop] = val,
                enumerable: true,
                configurable: true
            })
            this[prop] = this.getAttribute(prop);
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

customElements.define('hcw-body-footer', HcwBodyFooter);
customElements.define('hcw-flex', HcwFlex);
customElements.define('hcw-button', HcwButton);
customElements.define('hcw-input', HcwInput);
customElements.define('hcw-hero', HcwHero);