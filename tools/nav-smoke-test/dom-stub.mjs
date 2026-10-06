
// 最小 DOM 桩：仅覆盖 src/nav.js 用到的 API，用于无浏览器环境下验证注入逻辑
class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this.parentNode = null;
    this._attrs = new Map(); this._class = new Set();
    this._listeners = {}; this._text = '';
    this._rawHTML = null; this.dataset = {};
    this.hidden = false; this._style = {}; this.value = '';
    this.style = new Proxy(this._style, {});
  }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._class].join(' '); }
  set id(v) { this._attrs.set('id', String(v)); }
  get id() { return this._attrs.get('id') || ''; }
  setAttribute(k, v) {
    this._attrs.set(k, String(v));
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  removeAttribute(k) { this._attrs.delete(k); }
  hasAttribute(k) { return this._attrs.has(k); }
  set innerHTML(v) { this._rawHTML = String(v); this.children = []; this._text = ''; parseHTML(this, this._rawHTML); }
  get innerHTML() { return this._rawHTML === null ? this._text : this._rawHTML; }
  set textContent(v) { this._text = String(v); this._rawHTML = null; this.children = []; }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => (c instanceof El ? c.textContent : '')).join('');
  }
  get classList() {
    const s = this._class;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      contains: (c) => s.has(c),
      toggle: (c) => (s.has(c) ? (s.delete(c), false) : (s.add(c), true)),
    };
  }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  insertBefore(node, ref) {
    node.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node); else this.children.splice(i, 0, node);
    return node;
  }
  removeChild(node) { const i = this.children.indexOf(node); if (i >= 0) this.children.splice(i, 1); node.parentNode = null; return node; }
  remove() { this.parentNode?.removeChild(this); }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  dispatch(type, ev = {}) { (this._listeners[type] || []).forEach((f) => f({ type, preventDefault() {}, ...ev })); }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children.find((c) => c instanceof El) || null; }
  matches(sel) { return matchSel(this, sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { const out = []; walk(this, (e) => { if (e !== this && matchSel(e, sel)) out.push(e); }); return out; }
}
function walk(node, fn) { for (const c of node.children) { if (c instanceof El) { fn(c); walk(c, fn); } } }
function matchesSimple(el, part) {
  const m = part.match(/^([a-zA-Z0-9_-]*)((?:[.#][^.#\[]+)*)((?:\[[^\]]*\])*)$/);
  if (!m) return false;
  const [, tag, cls, attrs] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const token of (cls.match(/[.#][^.#]+/g) || [])) {
    if (token[0] === '.' && !el._class.has(token.slice(1))) return false;
    if (token[0] === '#' && el.id !== token.slice(1)) return false;
  }
  for (const a of (attrs.match(/\[[^\]]*\]/g) || [])) {
    const name = a.slice(1, -1).split('=')[0];
    if (!el._attrs.has(name)) return false;
  }
  return true;
}
function matchSel(el, sel) {
  for (const part of sel.split(',').map((s) => s.trim()).filter(Boolean)) {
    const bits = part.split(/\s+/);
    if (bits.length === 1) { if (matchesSimple(el, bits[0])) return true; continue; }
    // 只支持后代组合器
    const last = bits[bits.length - 1];
    if (!matchesSimple(el, last)) continue;
    let anc = el.parentNode, ok = true;
    for (let i = bits.length - 2; i >= 0; i--) {
      let found = false;
      while (anc) { if (anc instanceof El && matchesSimple(anc, bits[i])) { found = true; anc = anc.parentNode; break; } anc = anc.parentNode; }
      if (!found) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}
export function createDOM(html) {
  const body = new El('body');
  const htmlEl = new El('html');
  const doc = {
    body, documentElement: htmlEl, cookie: 'user_name=%E5%B0%8F%E6%98%8E; Path=/', title: (html.match(/<title>([\s\S]*?)<\/title>/i) || [, 'MLTTC'])[1].replace(/\s+/g, ' ').trim(),
    _listeners: {},
    createElement: (t) => new El(t),
    getElementById(id) { let hit = null; walk(body, (e) => { if (!hit && e.id === id) hit = e; }); return hit; },
    querySelector(sel) { return doc.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { const out = []; walk(body, (e) => { if (matchSel(e, sel)) out.push(e); }); return out; },
    addEventListener(t, fn) { (doc._listeners[t] ||= []).push(fn); },
    dispatch(t, ev = {}) { (doc._listeners[t] || []).forEach((f) => f({ type: t, ...ev })); },
  };
  parseHTML(body, html.split(/<body[^>]*>/)[1]?.split(/<\/body>/)[0] ?? html);
  return { doc, El };
}

// 极简 HTML 分词解析（够用即可：标签 / 文本 / 注释，不支持自闭合以外的复杂情况）
function parseHTML(root, src) {
  const re = /<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[^>]*?)?)\/?>|([^<]+)/g;
  const stack = [root];
  let m;
  while ((m = re.exec(src))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (m[2]) {
      const el = new El(m[2]);
      const attrStr = m[3] || '';
      for (const a of attrStr.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        if (!a[1]) continue;
        el.setAttribute(a[1], a[2] ?? '');
        if (a[1] === 'class') el.className = a[2] ?? '';
      }
      stack[stack.length - 1].appendChild(el);
      if (!/\/>$/.test(m[0]) && !['meta', 'link', 'br', 'hr', 'input', 'img'].includes(m[2].toLowerCase())) stack.push(el);
      continue;
    }
    if (m[4] && m[4].trim()) {
      const parent = stack[stack.length - 1];
      parent._text += m[4].replace(/\s+/g, ' ').trim();
    }
  }
  return root;
}

