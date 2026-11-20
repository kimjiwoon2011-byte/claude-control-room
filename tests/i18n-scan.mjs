// 코드에서 번역이 필요한 글을 모은다 (i18n.test.mjs 가 쓴다).
//   keys — t('…') 로 쓴 한국어 열쇠, 서버가 상수로 들고 있다가 t(상수[…]) 로 바꾸는 값, 화면 HTML 에 박힌 한국어
//   raw  — t() 를 거치지 않은 한국어 글 (주석은 뺀다)
import fs from 'node:fs';
import path from 'node:path';

export const KO = /[가-힣]/;
// 서버에서 상수로 들고 있다가 쓰는 곳에서 t(상수[...]) 로 바꾸는 것들 — 값이 사전에 있어야 한다
const INDIRECT = ['TOOL_KO', 'STATUS_KO', 'AI_KO', 'LANG_NOTE', 'STAFF_NAME', 'TASK_KO'];

const cook = raw => raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (m, e) => {
  if (e[0] === 'u' && e.length > 1) return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
  if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
  return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\r\n': '', '\n': '' }[e] ?? e;
});
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

// 자바스크립트를 글자 단위로 훑어 문자열·템플릿·정규식·주석을 가려낸다 (바깥 도구 없이 쓰려고 직접 짰다)
function scanJs(src, baseLine, file) {
  const starts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1);
  const lineAt = pos => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return baseLine + lo;
  };
  const ranges = [];
  for (const name of INDIRECT) {
    const m = new RegExp(`^const ${name} = `, 'm').exec(src);
    if (!m) continue;
    const end = src.indexOf(';\n', m.index);
    ranges.push([m.index, end < 0 ? src.length : end]);
  }
  const indirect = pos => ranges.some(([a, b]) => pos >= a && pos <= b);
  const out = { keys: [], raw: [], errors: [] };
  const n = src.length;
  const isTCall = start => {   // 바로 앞이 `t(` 인가
    let j = start - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (src[j] !== '(') return false;
    j--;
    while (j >= 0 && /\s/.test(src[j])) j--;
    return src[j] === 't' && (j === 0 || !/[\w$.]/.test(src[j - 1]));
  };
  const literal = (pos, value) => {
    const where = `${file}:${lineAt(pos)}`;
    if (isTCall(pos)) out.keys.push({ key: value, where });
    else if (KO.test(value)) (indirect(pos) ? out.keys : out.raw).push({ key: value, text: value, where });
  };
  const exprDepth = [];   // 템플릿의 ${ } 안에서 센 중괄호 깊이
  const tpls = [];        // 열려 있는 템플릿들
  let lastTok = '';
  const regexOk = () => lastTok === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(lastTok)
    || ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', '=>'].includes(lastTok);
  const templateText = pos => {
    const st = tpls[tpls.length - 1];
    let j = pos;
    let raw = '';
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') { raw += src.slice(j, j + 2); j += 2; continue; }
      if (ch === '`') {
        st.chunks.push({ raw, pos });
        tpls.pop();
        if (!st.hasExpr) literal(st.start, cook(st.chunks[0].raw));
        else {
          if (isTCall(st.start)) out.errors.push(`${file}:${lineAt(st.start)} t() 에 \${} 가 든 템플릿을 넣었어요 — {이름} 자리와 값을 따로 넘겨야 해요`);
          for (const c of st.chunks) if (KO.test(c.raw)) out.raw.push({ text: cook(c.raw).trim(), where: `${file}:${lineAt(c.pos)}` });
        }
        return j + 1;
      }
      if (ch === '$' && src[j + 1] === '{') { st.chunks.push({ raw, pos }); st.hasExpr = true; exprDepth.push(0); return j + 2; }
      raw += ch;
      j++;
    }
    return n;
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      literal(i, cook(src.slice(i + 1, j)));
      i = j + 1;
      lastTok = 'lit';
      continue;
    }
    if (c === '`') { tpls.push({ start: i, chunks: [], hasExpr: false }); i = templateText(i + 1); lastTok = 'lit'; continue; }
    if (c === '/') {
      if (regexOk()) {
        let j = i + 1;
        let cls = false;
        while (j < n) {
          const ch = src[j];
          if (ch === '\\') { j += 2; continue; }
          if (cls) { if (ch === ']') cls = false; } else if (ch === '[') cls = true; else if (ch === '/' || ch === '\n') break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        i = j;
        lastTok = 'lit';
        continue;
      }
      lastTok = '/';
      i++;
      continue;
    }
    if (c === '{') { if (exprDepth.length) exprDepth[exprDepth.length - 1]++; lastTok = '{'; i++; continue; }
    if (c === '}') {
      if (exprDepth.length) {
        if (exprDepth[exprDepth.length - 1] === 0) { exprDepth.pop(); i = templateText(i + 1); lastTok = 'lit'; continue; }
        exprDepth[exprDepth.length - 1]--;
      }
      lastTok = '}';
      i++;
      continue;
    }
    if (c === '=' && src[i + 1] === '>') { lastTok = '=>'; i += 2; continue; }
    if (/[\w$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(src[j])) j++; lastTok = src.slice(i, j); i = j; continue; }
    if (!/\s/.test(c)) lastTok = c;
    i++;
  }
  return out;
}

// 화면 HTML: 글 마디와 title·placeholder·aria-label 을 모은다. data-i18n="이름" 칸은 '@이름' 열쇠 하나로, translate="no" 칸은 건너뛴다.
function scanHtml(html, file) {
  const keys = [];
  const VOID = new Set(['br', 'input', 'img', 'meta', 'link', 'hr', 'source', 'wbr']);
  const body = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, m => m.replace(/[^\n]/g, ' '));   // 줄 번호를 지키며 지운다
  const lineAt = pos => (body.slice(0, pos).match(/\n/g) || []).length + 1;
  const stack = [];
  for (const m of body.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g)) {
    const [all, close, tag, attrs, text] = m;
    if (all.startsWith('<!--')) continue;
    const where = `${file}:${lineAt(m.index)}`;
    const closed = stack.some(s => s.rich || s.skip);
    if (text !== undefined) {
      const key = decode(text).replace(/\s+/g, ' ').trim();
      if (!closed && KO.test(key)) keys.push({ key, where });
      continue;
    }
    const name = tag.toLowerCase();
    if (close) {
      const k = stack.map(s => s.name).lastIndexOf(name);
      if (k >= 0) stack.length = k;
      continue;
    }
    const rich = /\bdata-i18n="([^"]+)"/.exec(attrs);
    const skip = /\btranslate="no"/.test(attrs);
    if (!closed && !skip) {
      for (const a of attrs.matchAll(/\b(title|placeholder|aria-label)="([^"]*)"/g)) {
        const key = decode(a[2]);
        if (KO.test(key)) keys.push({ key, where });
      }
      if (rich) keys.push({ key: `@${rich[1]}`, where });
    }
    if (!VOID.has(name) && !attrs.trim().endsWith('/')) stack.push({ name, rich: !!rich, skip });
  }
  return { keys, raw: [], errors: [] };
}

// index.html 에서 <script> 안쪽과 그 시작 줄 번호를 꺼낸다
export function pageScript(root) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  return { html, code: html.slice(start, end), start, end, line: (html.slice(0, start).match(/\n/g) || []).length + 1 };
}

export function scan(root) {
  const page = pageScript(root);
  const parts = [
    scanJs(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), 1, 'server.js'),
    scanJs(page.code, page.line, 'index.html'),
    scanHtml(page.html.slice(0, page.start) + page.html.slice(page.end), 'index.html'),
  ];
  return { keys: parts.flatMap(p => p.keys), raw: parts.flatMap(p => p.raw), errors: parts.flatMap(p => p.errors) };
}
