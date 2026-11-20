// 시험 도우미: 관제실 서버를 임시 폴더(--home)에서 가짜 AI 로 띄우고, API 로 일을 시키고, 상태가 바뀌길 기다린다.
// 진짜 Claude·GPT·CCR 과 사용자의 설정·기록 폴더는 건드리지 않는다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER = process.env.TEST_SERVER || path.join(ROOT, 'server.js');   // TEST_SERVER: 일부러 고장 낸 복사본으로 시험이 잡아내는지 볼 때
const FAKE_CLAUDE = path.join(ROOT, 'tests', 'fake-claude.mjs');
const FAKE_CODEX = path.join(ROOT, 'tests', 'fake-codex.mjs');

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'control-room-test-'));
export const removeDir = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// 저장된 기록(state.json)을 미리 써 둔다. 시험이 PC 언어에 흔들리지 않게, 따로 말하지 않으면
// 한국어 · 처음 설정을 마친 상태 · 감독관 꺼짐 · 일꾼 한 명(a1)으로 시작한다.
export function seed(home, { settings = {}, agents, ...rest } = {}) {
  const work = path.join(home, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'state.json'), JSON.stringify({
    settings: { setupDone: true, lang: 'ko', defaultCwd: work, ...settings, supervisor: { enabled: false, ...(settings.supervisor || {}) } },
    agents: agents || [{ id: 'a1', name: '일꾼 1' }],
    ...rest,
  }));
  return work;
}

// 가짜 ccr(claude-code-router): 불린 명령을 calls.log 에 적기만 한다 ('serve' 는 켜진 채로 남는다).
// 진짜 ccr 이 든 폴더는 PATH 에서 빼고 가짜를 맨 앞에 두어, 진짜 CCR 을 켜거나 끄는 일이 없게 한다.
export function fakeCcr(dir) {
  const pkg = path.join(dir, 'node_modules', '@musistudio', 'claude-code-router');
  const log = path.join(dir, 'calls.log');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@musistudio/claude-code-router', bin: { ccr: 'cli.js' } }));
  fs.writeFileSync(path.join(pkg, 'cli.js'), [
    `require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
    "if (process.argv[2] === 'serve') { console.log('http://127.0.0.1:1/?ccr_web_token=fake'); setInterval(() => {}, 1000); }",
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'ccr.cmd'), '@echo off\r\n');
  fs.writeFileSync(path.join(dir, 'ccr'), '#!/bin/sh\n', { mode: 0o755 });
  const real = d => ['ccr', 'ccr.cmd', 'ccr.exe', 'ccr.ps1'].some(n => fs.existsSync(path.join(d, n)));
  return {
    PATH: [dir, ...(process.env.PATH || '').split(path.delimiter).filter(d => d && !real(d))].join(path.delimiter),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}

// 서버를 띄운다. ccr: true 가 아니면 --no-ccr 로 켜서 CCR 을 건드리지 않는다.
export async function startServer({ home, args = [], env = {}, ccr = false } = {}) {
  const port = await freePort();
  const output = [];
  const childEnv = { ...process.env, FAKE_FAST: '1', ...env };
  if (env.PATH) for (const k of Object.keys(childEnv)) if (k !== 'PATH' && k.toLowerCase() === 'path') delete childEnv[k];   // 윈도의 'Path' 와 겹치지 않게
  const proc = spawn(process.execPath, [
    SERVER, '--no-open', ...(ccr ? [] : ['--no-ccr']), '--port', String(port), '--home', home,
    '--claude', FAKE_CLAUDE, '--codex', FAKE_CODEX, ...args,
  ], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', d => output.push(String(d)));
  proc.stderr.on('data', d => output.push(String(d)));
  const exited = new Promise(resolve => proc.once('exit', resolve));
  const base = `http://127.0.0.1:${port}`;

  // 엣지 창이 하는 것과 똑같이: 서버가 찍어 준 '한 번만 쓰는 주소'로 들어가 쿠키를 받고, 그 쿠키로 연 화면에서 열쇠를 읽는다
  let code;
  for (const t0 = Date.now(); !(code = bootCodes(output.join(''))[0]);) {
    if (proc.exitCode != null) throw new Error(`서버가 켜지지 못했어요:\n${output.join('')}`);
    if (Date.now() - t0 > 15000) throw new Error(`서버가 15초 안에 켜지지 않았어요:\n${output.join('')}`);
    await sleep(40);
  }
  const cookie = await enter(base, code);
  const token = /name="agent-token" content="([^"]+)"/.exec(await (await fetch(`${base}/`, { headers: { cookie } })).text())?.[1] || '';
  if (!token) throw new Error(`화면에서 열쇠를 받지 못했어요:\n${output.join('')}`);

  const raw = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-token': token, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const api = async (method, url, body) => {
    const r = await raw(method, url, body);
    if (r.status !== 200) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const state = () => api('GET', '/api/state');
  // 상태가 check 를 채울 때까지 기다렸다가 그 상태를 돌려준다
  const until = async (check, what, timeout = 20000) => {
    let s;
    for (const t0 = Date.now(); ;) {
      s = await state();
      if (check(s)) return s;
      if (Date.now() - t0 > timeout) {
        const tail = Object.entries(s.logs).map(([id, l]) => `[${id}] ${l.slice(-6).map(e => `${e.k}:${String(e.text ?? e.summary ?? e.status ?? '').slice(0, 80)}`).join(' | ')}`).join('\n');
        throw new Error(`${timeout}ms 를 기다려도 안 됐어요: ${what}\n${tail}`);
      }
      await sleep(40);
    }
  };
  const stop = async () => {
    try { await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-token': token } }); } catch { /* 이미 꺼짐 */ }
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    if (proc.exitCode == null) proc.kill();
  };
  return { home, port, base, token, cookie, raw, api, state, until, stop, output: () => output.join('') };
}

// 서버가 찍은 '한 번만 쓰는 창 주소'의 번호들 (찍힌 차례대로)
export const bootCodes = text => [...text.matchAll(/\/\?k=([0-9a-f]{32})/g)].map(m => m[1]);

// 그 번호로 들어가 받은 쿠키 ('이름=값'; 못 받았으면 '')
export async function enter(base, code) {
  const res = await fetch(`${base}/?k=${code}`, { redirect: 'manual' });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

// 임시 폴더에 서버를 띄우고 fn 을 돌린 뒤, 서버를 끄고 폴더를 지운다. seed: false 면 처음 켜는 상태 그대로 둔다.
export async function withServer(opts, fn) {
  if (typeof opts === 'function') [opts, fn] = [{}, opts];
  const home = tempDir();
  const { seed: seeded, ...rest } = opts;
  if (seeded !== false) seed(home, seeded || {});
  const srv = await startServer({ ...rest, home });
  try {
    return await fn(srv);
  } finally {
    await srv.stop();
    removeDir(home);
  }
}

// 서버 상태가 아닌 것(파일 등)이 check 를 채울 때까지 기다린다
export async function waitFor(check, what, timeout = 10000) {
  for (const t0 = Date.now(); ;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`${timeout}ms 를 기다려도 안 됐어요: ${what}`);
    await sleep(40);
  }
}

// 상태에서 자주 꺼내 보는 것들
export const agentOf = (s, id) => s.staff?.[id] || (id === 'supervisor' ? s.supervisor : s.agents.find(a => a.id === id));   // 감독관·팀장·보안 검사관·테스터는 staff 에 있다
export const idle = id => s => { const a = agentOf(s, id); return !!a && a.status === 'idle' && !a.current && !a.queue.length; };
export const logOf = (s, id) => s.logs[id] || [];
export const said = (s, id) => logOf(s, id).filter(e => e.k === 'text').map(e => e.text);
