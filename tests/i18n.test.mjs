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
  // 번역하지 않는 것: 한국어 조사(값으로 넘긴다), 파일 이름, 윈도 창 제목
  const ALLOWED = new Set(['이', '가', '을', '를', '과', '와', '로그인.bat', 'start "Claude 로그인" "', 'start "GPT 로그인" "']);
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

test('영어 글에는 한국어가 남아 있지 않다', () => {
  const ALLOWED = new Set(['@offline', '관제실을 켤 때처럼 실행.bat(바탕화면의 클로드 관제실)을 다시 눌러 주세요. 열쇠가 든 새 창이 열려요.']);   // 파일 이름 '실행.bat' 이 들어 있다
  const left = Object.entries(dict).filter(([ko, en]) => KO.test(en) && !ALLOWED.has(ko)).map(([ko]) => JSON.stringify(ko));
  assert.deepEqual(left, [], `한국어가 남은 영어 글:${list(left)}`);
});
