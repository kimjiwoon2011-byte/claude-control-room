// 번역 사전(locales/en.json) 시험: 화면과 서버가 쓰는 글이 사전과 어긋나지 않는지 본다.
// 새 글을 넣고 사전에 안 넣으면 영어 화면에 한국어가 그대로 보이는데, 그걸 여기서 잡는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.mjs';
import { scan, pageScript, KO } from './i18n-scan.mjs';

const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
const found = scan(ROOT);
const used = new Set(found.keys.map(k => k.key));
const list = items => `\n  ${items.join('\n  ')}\n`;

test('index.html 의 스크립트는 문법 오류 없이 읽힌다', () => {
  const page = pageScript(ROOT);
  assert.doesNotThrow(() => new vm.Script(page.code, { filename: 'index.html', lineOffset: page.line - 1 }));
});

test('화면과 서버가 쓰는 한국어 글은 모두 영어 사전에 있다', () => {
  const missing = [...new Map(found.keys.filter(k => !(k.key in dict)).map(k => [k.key, `${k.where}  ${JSON.stringify(k.key)}`])).values()];
  assert.deepEqual(missing, [], `locales/en.json 에 없는 글:${list(missing)}`);
});

test('영어 사전에는 쓰지 않는 글이 남아 있지 않다', () => {
  const unused = Object.keys(dict).filter(k => !used.has(k)).map(k => JSON.stringify(k));
  assert.deepEqual(unused, [], `코드에서 안 쓰는 사전 글:${list(unused)}`);
});

test('한국어 글은 모두 t() 를 거친다', () => {
  // 번역하지 않는 것: 한국어 조사(값으로 넘긴다), 기본 이름을 알아보려고 사전을 찾는 열쇠(DEFAULT_NAME)
  const ALLOWED = new Set(['이', '가', '을', '를', '과', '와', '클로드 {n}']);
  const raw = found.raw.filter(r => !ALLOWED.has(r.text)).map(r => `${r.where}  ${JSON.stringify(r.text)}`);
  assert.deepEqual([...raw, ...found.errors], [], `t() 로 감싸지 않은 글:${list([...raw, ...found.errors])}`);
});

test('영어 글은 한국어 글과 같은 {자리}를 쓴다', () => {
  const PARTICLES = new Set(['ga', 'wa', 'eul']);   // 한국어 조사 자리: 영어에는 없어도 된다
  const vars = s => new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]));
  const bad = Object.entries(dict).filter(([ko, en]) => {
    const k = vars(ko);
    const e = vars(en);
    return [...k].some(v => !e.has(v) && !PARTICLES.has(v)) || [...e].some(v => !k.has(v));
  }).map(([ko]) => JSON.stringify(ko));
  assert.deepEqual(bad, [], `{자리}가 안 맞는 글:${list(bad)}`);
});

// 영어 말고 다른 언어 사전 (server.js 의 LANGS 에서 한국어·영어를 뺀 것): 영어 사전과 같은 글을 다 갖고,
// {자리}와 HTML 태그(<b> 등)를 그대로 쓰고, 한국어가 남지 않아야 한다
const LANGS = JSON.parse(/const LANGS = (\[[^\]]*\])/.exec(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'))[1].replace(/'/g, '"'));
const OTHERS = LANGS.filter(l => l !== 'ko' && l !== 'en');

test('다른 언어 사전도 영어 사전과 같은 글을 모두 갖고, {자리}·HTML 태그를 그대로 쓰며, 한국어가 남지 않는다', () => {
  assert.ok(OTHERS.length > 0, 'server.js 의 LANGS 에 한국어·영어 말고 다른 언어가 없다');
  const vars = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).filter(v => !['ga', 'wa', 'eul'].includes(v)).sort().join(',');
  // 진짜 HTML 태그만 센다 (<b>, <span class="…">). AI 에게 주는 글의 <file name> 같은 자리 표시는 번역해도 된다
  const tags = s => [...s.matchAll(/<\/?([a-z]+)(?=\s+[a-z-]+=|\s*\/?>)/gi)].map(m => m[0].toLowerCase()).sort().join(',');
  const problems = [];
  for (const lang of OTHERS) {
    const file = path.join(ROOT, 'locales', `${lang}.json`);
    if (!fs.existsSync(file)) { problems.push(`${lang}: locales/${lang}.json 이 없다`); continue; }
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of Object.keys(dict)) {
      if (!(k in d)) { problems.push(`${lang}: 빠진 글 ${JSON.stringify(k)}`); continue; }
      if (typeof d[k] !== 'string' || !d[k].trim()) problems.push(`${lang}: 빈 글 ${JSON.stringify(k)}`);
      else {
        if (vars(d[k]) !== vars(dict[k])) problems.push(`${lang}: {자리}가 다름 ${JSON.stringify(k)}`);
        if (tags(d[k]) !== tags(dict[k])) problems.push(`${lang}: 태그가 다름 ${JSON.stringify(k)}`);
        if (KO.test(d[k])) problems.push(`${lang}: 한국어가 남음 ${JSON.stringify(k)}`);
      }
    }
    for (const k of Object.keys(d)) if (!(k in dict)) problems.push(`${lang}: 영어 사전에 없는 글 ${JSON.stringify(k)}`);
  }
  assert.deepEqual(problems.slice(0, 40), [], `다른 언어 사전 문제 (${problems.length}개):${list(problems.slice(0, 40))}`);
});

test('영어 글에는 한국어가 남아 있지 않다', () => {
  const left = Object.entries(dict).filter(([ko, en]) => KO.test(en)).map(([ko]) => JSON.stringify(ko));
  assert.deepEqual(left, [], `한국어가 남은 영어 글:${list(left)}`);
});
