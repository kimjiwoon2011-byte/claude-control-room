// 화면(index.html) 시험: 브라우저 없이 글만 읽어서 잡을 수 있는 실수를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT } from './helpers.mjs';
import { pageScript } from './i18n-scan.mjs';

const page = pageScript(ROOT);
const list = items => `\n  ${items.join('\n  ')}\n`;
// 주석을 뺀 스크립트 (주석 속 낱말에 걸리지 않게). 줄 수는 그대로 둔다
const code = page.code.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('스크립트가 찾는 #id 는 모두 화면에 있다', () => {
  const ids = new Set([...page.html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]));
  // `#v-${view}` 처럼 이름을 이어 붙이는 곳은 뺀다
  const wanted = new Set([...code.matchAll(/\$\$?\(\s*['"`]#([\w-]+)(?![\w-]|\$\{)/g)].map(m => m[1]));
  const missing = [...wanted].filter(id => !ids.has(id));
  assert.ok(wanted.size > 50, '스크립트에서 #id 를 거의 못 찾았어요 — 시험이 낡았을 수 있어요');
  assert.deepEqual(missing, [], `화면에 없는 #id:${list(missing)}`);
});

test('브라우저의 confirm·alert·prompt 창 대신 앱 안의 물어보는 창(ask)을 쓴다', () => {
  const lines = code.split('\n');
  const bad = lines.map((line, i) => [i, line]).filter(([, line]) => /(^|[^\w.$])(confirm|alert|prompt)\(/.test(line))
    .map(([i, line]) => `index.html:${page.line + i}  ${line.trim().slice(0, 90)}`);
  assert.deepEqual(bad, [], `브라우저 창을 띄우는 곳:${list(bad)}`);
});

test('화면의 data-act 버튼은 모두 처리하는 곳이 있다', () => {
  const acts = new Set([...page.html.matchAll(/\bdata-act="([\w-]+)"/g)].map(m => m[1]));
  const handled = new Set([
    ...[...code.matchAll(/case '([\w-]+)'/g)].map(m => m[1]),
    ...[...code.matchAll(/dataset\.act === '([\w-]+)'/g)].map(m => m[1]),
    ...[...code.matchAll(/\[data-act="([\w-]+)"\]/g)].map(m => m[1]),
  ]);
  const missing = [...acts].filter(a => !handled.has(a));
  assert.deepEqual(missing, [], `누르면 아무 일도 안 하는 버튼:${list(missing)}`);
});
