// 관제실 서버 시험. 서버를 임시 폴더에서 가짜 AI(tests/fake-*.mjs)로 띄우고 API 로 확인한다.
// 가짜 AI 가 알아듣는 낱말(빠르게·기다려·고장·쪽지 보기 …)은 각 가짜 파일 맨 위에 적혀 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, SERVER, withServer, startServer, seed, fakeCcr, tempDir, removeDir, waitFor, agentOf, idle, logOf, said, bootCodes, enter } from './helpers.mjs';

const onWindows = process.platform === 'win32';   // 관제실이 CCR 을 직접 켜는 것은 윈도에서만 한다
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const send = (srv, text, id = 'a1') => srv.api('POST', `/api/agents/${id}/send`, { text });
const handover = (srv, target, id = 'a1') => srv.api('POST', `/api/agents/${id}/handover`, { target });
const working = text => s => said(s, 'a1').includes(text);
const note = s => said(s, 'a1').find(t => t.startsWith('쪽지: '));   // 가짜 AI 가 '쪽지 보기'에 답한 말
const SUPERVISOR_ON = { settings: { supervisor: { enabled: true } } };
// 대체 AI 를 켜 둔 상태로 시작하게 하는 기록 (게이트웨이 주소는 아무도 안 듣는 곳)
const FALLBACK_ON = { settings: { fallbackEnabled: true, fallbackUrl: 'http://127.0.0.1:9' } };

// ───────────────────────── 실행 옵션·보안 ─────────────────────────

test('--home: 설정·기록·작업 폴더가 앱 폴더가 아니라 그 폴더 아래에 생긴다', async () => {
  await withServer({ seed: false }, async srv => {
    const s = await srv.state();
    assert.equal(s.app.dataDir, path.join(srv.home, 'data'));
    assert.equal(s.settings.defaultCwd, path.join(srv.home, 'workspace'));
  });
});

test('상태 읽기(/api/state): 열쇠가 맞아야 지금 상태를 준다', async () => {
  await withServer(async srv => {
    const ok = await srv.raw('GET', '/api/state');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.agents.map(a => a.id), ['a1']);
    const wrong = await srv.raw('GET', '/api/state', undefined, { 'x-token': 'wrong' });
    assert.equal(wrong.status, 401);
  });
});

test('내 PC 주소가 아닌 Host 로 온 요청은 화면조차 주지 않는다', async () => {
  await withServer(async srv => {
    const get = host => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: srv.port, path: '/', headers: { Host: host, cookie: srv.cookie } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(await get('evil.example'), 403);
    assert.equal(await get(`localhost:${srv.port}`), 200);
  });
});

test('화면(/)을 그냥 읽어서는 열쇠를 얻지 못한다: 한 번만 쓰는 주소로 받은 쿠키가 있어야 열쇠가 든 화면을 준다', async () => {
  await withServer(async srv => {
    // 아무나 (예: 샌드박스 안의 GPT 가 이 PC 주소로) 화면을 읽으면 '열쇠 없음' 안내만 받는다
    const bare = await fetch(`${srv.base}/`);
    assert.equal(bare.status, 401);
    assert.ok(!(await bare.text()).includes(srv.token));
    // 쓴 번호는 다시 못 쓰고, 틀린 쿠키도 안 된다
    assert.equal(await enter(srv.base, bootCodes(srv.output())[0]), '');
    assert.equal(await enter(srv.base, '0'.repeat(32)), '');
    assert.equal((await fetch(`${srv.base}/`, { headers: { cookie: srv.cookie.replace(/=.*/, '=wrong') } })).status, 401);
    // 쿠키가 맞으면 열쇠가 든 화면
    const page = await fetch(`${srv.base}/`, { headers: { cookie: srv.cookie } });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes(`content="${srv.token}"`));
    // API 는 열쇠(x-token 머리글)가 있어야 한다: 주소 뒤에 붙인 열쇠나 쿠키만으로는 안 된다 (다른 포트의 페이지가 쿠키를 빌려 쓰지 못하게)
    assert.equal((await fetch(`${srv.base}/api/state?token=${srv.token}`)).status, 401);
    assert.equal((await fetch(`${srv.base}/api/state`, { headers: { cookie: srv.cookie } })).status, 401);
  });
});

test('화면 연결(/api/events)은 쿠키로 열리고, 맨 처음에 전체 상태를 보낸다', async () => {
  await withServer(async srv => {
    assert.equal((await fetch(`${srv.base}/api/events`)).status, 401);
    const stop = new AbortController();
    const res = await fetch(`${srv.base}/api/events`, { headers: { cookie: srv.cookie }, signal: stop.signal });
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('\n\ndata: ') || !text.endsWith('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    stop.abort();
    const first = JSON.parse(text.split('\n\n').find(part => part.startsWith('data: ')).slice(6));
    assert.equal(first.type, 'snapshot');
    assert.deepEqual(first.agents.map(a => a.id), ['a1']);
  });
});

test('대체 AI 를 켜 두면 관제실이 CCR 을 직접 켠다 (먼저 stop, 그다음 serve)', { skip: !onWindows }, async () => {
  const bin = tempDir();
  const ccr = fakeCcr(bin);
  try {
    await withServer({ ccr: true, env: { PATH: ccr.PATH }, seed: FALLBACK_ON }, async () => {
      await waitFor(() => ccr.calls().length >= 2, '가짜 ccr 이 두 번 불림');
      assert.deepEqual(ccr.calls().slice(0, 2), ['stop', 'serve --no-open']);
    });
  } finally {
    removeDir(bin);
  }
});

test('--no-ccr: 대체 AI 를 켜 둬도 CCR 을 켜거나 끄지 않는다', { skip: !onWindows }, async () => {
  const bin = tempDir();
  const ccr = fakeCcr(bin);
  try {
    await withServer({ ccr: false, env: { PATH: ccr.PATH }, seed: FALLBACK_ON }, async srv => {
      await srv.api('POST', '/api/ccr/check');   // CCR 을 챙기는 길을 끝까지 한 번 돌린다
      assert.deepEqual(ccr.calls(), []);
    });
  } finally {
    removeDir(bin);
  }
});

// ───────────────────────── 일 시키기·허락·멈추기 ─────────────────────────

test('일을 보내면 에이전트가 끝낸 뒤 기록에 남는다', async () => {
  await withServer(async srv => {
    await send(srv, '빠르게 제목 고쳐 줘');
    const s = await srv.until(st => idle('a1')(st) && st.history.length === 1, '일이 끝남');
    assert.equal(s.history[0].status, 'done');
    assert.equal(s.history[0].prompt, '빠르게 제목 고쳐 줘');
    assert.equal(s.history[0].result, '고쳤어요.');
    assert.equal(agentOf(s, 'a1').stats.runs, 1);
  });
});

for (const [decision, result] of [['allow', /테스트까지 마쳤어요/], ['deny', /테스트는 건너뛰었어요/]]) {
  test(`허락 요청에 ${decision} 로 답하면 그 답이 에이전트에게 전해진다`, async () => {
    await withServer(async srv => {
      await send(srv, '로그인 페이지 만들어 줘');
      let s = await srv.until(st => agentOf(st, 'a1').pending.length === 1, '허락 요청이 뜸');
      const ask = agentOf(s, 'a1').pending[0];
      assert.equal(ask.tool, 'Bash');
      assert.equal(ask.summary, 'npm test');
      await srv.api('POST', '/api/agents/a1/permission', { requestId: ask.requestId, decision });
      s = await srv.until(idle('a1'), '일이 끝남');
      assert.match(s.history[0].result, result);
    });
  });
}

test('멈추면 하던 일은 중지로 남고 기다리던 일도 비운다', async () => {
  await withServer(async srv => {
    await send(srv, '기다려');
    await srv.until(working('일하는 중이에요.'), '일하는 중');
    await send(srv, '다음 일');
    await srv.api('POST', '/api/agents/a1/stop');
    const s = await srv.until(idle('a1'), '멈춤');
    assert.deepEqual(s.history.map(h => h.status), ['stopped']);
  });
});

test('기다리는 일 하나만 골라서 뺄 수 있다', async () => {
  await withServer(async srv => {
    await send(srv, '기다려');
    await srv.until(working('일하는 중이에요.'), '일하는 중');
    await send(srv, '두 번째 일');
    await send(srv, '세 번째 일');
    let s = await srv.state();
    assert.deepEqual(agentOf(s, 'a1').queue.map(q => q.text), ['두 번째 일', '세 번째 일']);
    await srv.api('DELETE', `/api/agents/a1/queue/${agentOf(s, 'a1').queue[0].id}`);
    s = await srv.state();
    assert.deepEqual(agentOf(s, 'a1').queue.map(q => q.text), ['세 번째 일']);
  });
});

// ───────────────────────── 감독관 ─────────────────────────

test('감독관: 고칠 점을 찾으면 일꾼에게 다시 시키고, 고친 뒤 통과시킨다 (보고 카드는 한 장)', async () => {
  await withServer({ seed: SUPERVISOR_ON }, async srv => {
    await send(srv, '빠르게 제목 고쳐 줘');
    const s = await srv.until(st => st.reports[0]?.state === 'pass' && idle('a1')(st) && idle('supervisor')(st), '검토 통과');
    assert.equal(s.reports.length, 1);
    assert.equal(s.reports[0].task, '빠르게 제목 고쳐 줘');
    assert.deepEqual(s.reports[0].steps.map(x => `${x.round}:${x.verdict}`), ['0:fix', '1:pass']);
    assert.equal(s.history.filter(h => h.agentId === 'a1').length, 2);   // 처음 일 + 고치기 한 번
  });
});

test('GPT 에이전트가 파일을 고쳐도 감독관 검토가 열린다', async () => {
  await withServer({ seed: { ...SUPERVISOR_ON, agents: [{ id: 'a1', name: '일꾼 1', engine: 'codex' }] } }, async srv => {
    await send(srv, '버튼 고쳐 줘');
    const s = await srv.until(st => st.reports[0]?.state === 'pass' && idle('a1')(st) && idle('supervisor')(st), '검토 통과');
    assert.deepEqual(s.reports[0].files, ['index.html']);
  });
});

// ───────────────────────── 검사 팀 (감독관 → 보안 검사관 → 테스터) ─────────────────────────

const TEAM_ON = { settings: { supervisor: { enabled: true }, security: { enabled: true }, tester: { enabled: true } } };
const STAFF_IDLE = ['supervisor', 'security', 'tester', 'lead'];

test('검사 팀: 감독관 → 보안 검사관 → 테스터 차례로 보고, 돌려보낸 일은 고친 뒤 처음 자리부터 다시 본다', async () => {
  await withServer({ seed: TEAM_ON }, async srv => {
    await send(srv, '빠르게 제목 고쳐 줘');
    let s = await srv.until(st => agentOf(st, 'tester')?.pending.length, '테스터가 명령 허락을 묻는다');
    const req = agentOf(s, 'tester').pending[0];
    assert.equal(req.summary, 'npm test');
    assert.equal(s.reports[0].stage, 'tester');
    assert.match(said(s, 'tester')[0], /permission=manual tools=Read,Glob,Grep,Bash/);   // 테스터는 명령마다 사용자에게 묻는다
    assert.match(said(s, 'tester')[0], /lean=true/);   // MCP 도구·스킬을 빼서 검사 한 번에 수십만 토큰을 쓰지 않는다
    await srv.api('POST', '/api/agents/tester/permission', { requestId: req.requestId, decision: 'allow' });
    s = await srv.until(st => st.reports[0]?.state === 'pass' && idle('a1')(st) && STAFF_IDLE.every(id => idle(id)(st)), '검사 모두 통과');
    assert.equal(s.reports.length, 1);
    assert.deepEqual(s.reports[0].steps.map(x => `${x.stage}:${x.round}:${x.verdict}`),
      ['supervisor:0:fix', 'supervisor:1:pass', 'security:1:pass', 'tester:1:pass']);
  });
});

test('검사 팀: 보안 검사관이 돌려보내면 그 일꾼이 고치고, 보안 검사관이 다시 본다 (감독관이 꺼져 있으면 건너뛴다)', async () => {
  await withServer({ seed: { settings: { security: { enabled: true } } } }, async srv => {
    fs.writeFileSync(path.join(srv.home, 'work', 'LEAK'), '');
    await send(srv, '빠르게 설정 고쳐 줘');
    const s = await srv.until(st => st.reports[0]?.state === 'pass' && idle('a1')(st) && idle('security')(st), '보안 검사 통과');
    assert.deepEqual(s.reports[0].steps.map(x => `${x.stage}:${x.round}:${x.verdict}`), ['security:0:fix', 'security:1:pass']);
    const fixTask = logOf(s, 'a1').filter(e => e.k === 'user')[1].text;
    assert.match(fixTask, /^\[보안 검사관 수정 요청 1\/2\]/);
    assert.equal(logOf(s, 'supervisor').length, 0);
  });
});

test('검사 팀: GPT 테스터만 작업 폴더에 쓸 수 있고, GPT 보안 검사관은 읽기만 한다', async () => {
  await withServer({ seed: { settings: { security: { enabled: true, engine: 'codex' }, tester: { enabled: true, engine: 'codex' } } } }, async srv => {
    await send(srv, '빠르게 제목 고쳐 줘');
    const s = await srv.until(st => st.reports[0]?.state === 'pass' && idle('tester')(st), 'GPT 검사 통과');
    // 윈도의 읽기 전용 샌드박스에서는 한글이 깨지지 않게 cmd /c type 으로 읽으라고 알려 준다 (쓰기 되는 샌드박스는 괜찮다)
    const type = onWindows ? ', type' : '';
    assert.deepEqual(s.reports[0].steps.map(x => `${x.stage}:${x.verdict}:${x.summary}`),
      [`security:pass:GPT 검사 (sandbox=read-only${type})`, 'tester:pass:GPT 검사 (sandbox=workspace-write)']);
  });
});

test('GPT: 켤 때 mxc 샌드박스를 쓸 수 있는지 보고, 되면 mxc(이 PC·인터넷 연결이 막힘)로, 안 되면 unelevated 로 돌린다', { skip: !onWindows }, async () => {
  const gpt = { agents: [{ id: 'a1', name: '일꾼 1', engine: 'codex', permissionMode: 'plan' }] };   // 읽기 전용 샌드박스
  const line = s => said(s, 'a1').find(x => x.includes('win='));
  await withServer({ seed: gpt, env: { FAKE_MXC: '1' } }, async srv => {
    await srv.until(s => s.codex.sandbox === 'mxc', 'mxc 를 쓸 수 있다고 봄');
    await send(srv, '설정 보기');
    const s = await srv.until(line, 'GPT 가 답함');
    assert.match(line(s), /win=mxc type=false/);   // mxc 에서는 한글이 깨지지 않아 cmd /c type 안내가 없다
  });
  await withServer({ seed: gpt }, async srv => {
    await srv.until(s => s.codex.sandbox === 'unelevated', 'mxc 를 못 쓴다고 봄');
    await send(srv, '설정 보기');
    const s = await srv.until(line, 'GPT 가 답함');
    assert.match(line(s), /win=unelevated type=true/);
  });
});

test('GPT(mxc): 로그인·열쇠 파일과 관제실 기록 폴더는 읽지도 못하게 막는다 (mxc 가 아니면 이 기능이 없어 그대로)', { skip: !onWindows }, async () => {
  // 사용자 폴더를 임시 폴더로 바꿔서, 진짜 로그인 파일 대신 가짜를 두고 본다
  const fake = tempDir();
  const appData = path.join(fake, 'AppData', 'Roaming');
  const secrets = [path.join(fake, '.codex', 'auth.json'), path.join(fake, '.claude', '.credentials.json')];
  for (const f of secrets) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{}'); }
  fs.mkdirSync(path.join(appData, 'claude-code-router'), { recursive: true });
  const slash = p => JSON.stringify(p.split(path.sep).join('/'));
  const gpt = { agents: [{ id: 'a1', name: '일꾼 1', engine: 'codex', permissionMode: 'plan' }] };
  const line = s => said(s, 'a1').find(x => x.includes('perm='));
  try {
    await withServer({ seed: gpt, env: { FAKE_MXC: '1', USERPROFILE: fake, HOME: fake, APPDATA: appData } }, async srv => {
      await srv.until(s => s.codex.sandbox === 'mxc', 'mxc 를 쓸 수 있다고 봄');
      await send(srv, '설정 보기');
      const s = await srv.until(line, 'GPT 가 답함');
      assert.match(line(s), /^sandbox=read-only win=mxc /);   // -s 대신 권한 묶음으로 받아도 읽기 전용 그대로
      assert.match(line(s), /perm="cr"/);
      for (const p of [...secrets, path.join(appData, 'claude-code-router'), path.join(srv.home, 'data')]) assert.ok(line(s).includes(`${slash(p)}="deny"`), p);
      assert.ok(!line(s).includes('.ssh'));   // 없는 곳은 넣지 않는다
    });
    await withServer({ seed: gpt, env: { USERPROFILE: fake, HOME: fake, APPDATA: appData } }, async srv => {
      await srv.until(s => s.codex.sandbox === 'unelevated', 'mxc 를 못 쓴다고 봄');
      await send(srv, '설정 보기');
      const s = await srv.until(line, 'GPT 가 답함');
      assert.match(line(s), /^sandbox=read-only win=unelevated .* perm=- deny=-$/);
    });
  } finally {
    removeDir(fake);
  }
});

test('위험한 작업 폴더(드라이브 맨 위·사용자 폴더 전체·관제실 앱이나 기록 폴더를 품은 곳·기록 폴더 안)는 고를 수 없고, 저장돼 있던 곳이면 일을 시작하지 않는다', async () => {
  await withServer(async srv => {
    const data = path.join(srv.home, 'data');
    fs.mkdirSync(path.join(data, 'sub'), { recursive: true });
    const bad = [path.parse(srv.home).root, os.homedir(), ROOT, path.dirname(ROOT), data, path.join(data, 'sub'), srv.home];
    for (const dir of bad) {
      assert.equal((await srv.raw('PATCH', '/api/agents/a1', { cwd: dir })).status, 400, `일꾼 폴더 ${dir}`);
      assert.equal((await srv.raw('POST', '/api/settings', { defaultCwd: dir })).status, 400, `기본 폴더 ${dir}`);
      assert.equal((await srv.raw('POST', '/api/setup', { defaultCwd: dir })).status, 400, `처음 설정 ${dir}`);
    }
    const ok = path.join(srv.home, 'ok');
    fs.mkdirSync(ok);
    assert.equal((await srv.raw('PATCH', '/api/agents/a1', { cwd: ok })).status, 200);
  });
  const home = tempDir();
  seed(home, { agents: [{ id: 'a1', name: '일꾼 1', cwd: path.join(home, 'data') }] });
  const srv = await startServer({ home });
  try {
    await send(srv, '빠르게 고쳐 줘');
    const s = await srv.until(st => logOf(st, 'a1').some(e => e.k === 'err'), '일을 시작하지 않고 알림');
    assert.match(logOf(s, 'a1').find(e => e.k === 'err').text, /기록 폴더/);
    assert.ok(!logOf(s, 'a1').some(e => e.k === 'user'));
  } finally {
    await srv.stop();
    removeDir(home);
  }
});

test('claude 위치는 claude 실행 파일만, 작업 폴더 밖에서만 / 대체 AI 주소는 이 PC 만 고를 수 있다', async () => {
  await withServer(async srv => {
    const bin = path.join(srv.home, 'bin');
    fs.mkdirSync(bin);
    const file = (dir, name) => { const f = path.join(dir, name); fs.writeFileSync(f, ''); return f; };
    const set = b => srv.raw('POST', '/api/settings', b).then(r => r.status);
    assert.equal(await set({ claudePath: file(bin, 'evil.exe') }), 400);   // claude 가 아닌 프로그램
    assert.equal(await set({ claudePath: file(path.join(srv.home, 'work'), 'claude.exe') }), 400);   // GPT 가 쓸 수 있는 작업 폴더 안
    assert.equal(await set({ claudePath: file(bin, 'claude.exe') }), 200);
    assert.equal(await set({ claudePath: '' }), 200);   // 비우면 다시 저절로 찾는다
    assert.equal(await set({ fallbackUrl: 'http://evil.example:3456' }), 400);   // 시킨 일과 CCR 열쇠가 그 서버로 간다
    assert.equal(await set({ fallbackUrl: 'https://127.0.0.1.evil.example/' }), 400);
    assert.equal(await set({ fallbackUrl: 'http://localhost:3456' }), 200);
    assert.equal(await set({ fallbackUrl: 'http://127.0.0.1:3456' }), 200);
  });
});

test('CCR 열쇠는 윈도 암호화(DPAPI)로 저장하고 다시 켜면 풀어 쓴다 — 예전 평문 기록도 다음 저장 때 바꿔 둔다', { skip: !onWindows }, async () => {
  const home = tempDir();
  seed(home, { settings: { fallbackKey: 'sk-old-plain-123' } });   // 예전처럼 평문으로 저장돼 있던 기록
  const file = path.join(home, 'data', 'state.json');
  let srv = await startServer({ home });
  try {
    assert.equal((await srv.state()).settings.fallbackKey, 'sk-old-plain-123');
    await srv.api('POST', '/api/settings', { sound: false });   // 아무거나 바꿔서 저장시킨다
    await srv.stop();
    let raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('sk-old-plain-123'), '평문 열쇠가 남아 있다');
    assert.match(raw, /"fallbackKeyEnc":"[A-Za-z0-9+/=]{40,}"/);
    srv = await startServer({ home });
    assert.equal((await srv.state()).settings.fallbackKey, 'sk-old-plain-123');
    await srv.api('POST', '/api/settings', { fallbackKey: 'sk-new-secret-456' });
    await srv.stop();
    raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('sk-new-secret-456'));
    srv = await startServer({ home });
    assert.equal((await srv.state()).settings.fallbackKey, 'sk-new-secret-456');
  } finally {
    await srv.stop();
    removeDir(home);
  }
});

test('보안 기록: 허락·막은 일·위험한 설정 바꾸기·열쇠 없는 접근을 남기고(열쇠 값은 빼고), 다시 켜도 남아 있다', async () => {
  const home = tempDir();
  seed(home);
  let srv = await startServer({ home });
  try {
    await send(srv, '파일 살펴봐 줘');   // 가짜 claude 는 npm test 를 돌려도 되는지 허락을 구한다
    const asked = await srv.until(st => agentOf(st, 'a1').pending.length, '허락 요청');
    await srv.api('POST', '/api/agents/a1/permission', { requestId: agentOf(asked, 'a1').pending[0].requestId, decision: 'deny' });
    await srv.raw('PATCH', '/api/agents/a1', { cwd: home });   // 기록 폴더를 품은 곳이라 막힌다
    await srv.api('POST', '/api/settings', { fallbackUrl: 'http://localhost:3999', fallbackKey: 'sk-sec-test-789' });
    await fetch(`${srv.base}/api/state`);   // 열쇠 없이
    const s = await srv.until(st => st.security?.some(e => e.kind === 'auth'), '보안 기록이 쌓임');
    const has = (kind, check) => s.security.some(e => e.kind === kind && check(e));
    assert.ok(has('perm', e => e.decision === 'deny' && e.agent === '일꾼 1'), '허락 거절');
    assert.ok(has('blocked', e => e.what === 'cwd'), '위험한 폴더 막음');
    assert.ok(has('setting', e => e.key === 'fallbackUrl' && e.to === 'http://localhost:3999'), '게이트웨이 주소 바꿈');
    assert.ok(has('setting', e => e.key === 'fallbackKey' && e.to === undefined), '열쇠 바꿈 (값 없이)');
    assert.ok(has('auth', e => e.what === 'token'), '열쇠 없는 API 접근');
    await srv.stop();
    const raw = fs.readFileSync(path.join(home, 'data', 'security.jsonl'), 'utf8');
    assert.ok(!raw.includes('sk-sec-test-789'), '보안 기록에 열쇠 값이 들어갔다');
    srv = await startServer({ home });
    assert.ok((await srv.state()).security.some(e => e.kind === 'perm'), '다시 켜도 남아 있다');
  } finally {
    await srv.stop();
    removeDir(home);
  }
});

test('팀 게시판: 팀장의 약속이 첫 글, 일꾼은 게시판을 받아 일하고 끝나면 [게시판] 소식을 올리며, 뒤 조각은 앞 소식을 받는다 (.team-board.md·결과 모으기에도)', async () => {
  const seedTeam = { settings: { lead: { enabled: true, approve: false } }, agents: [{ id: 'a1', name: '일꾼 1' }, { id: 'a2', name: '일꾼 2' }] };
  await withServer({ seed: seedTeam }, async srv => {
    await srv.api('POST', '/api/send', { text: '할 일 앱 순서대로 만들어 줘', target: 'lead' });
    const s = await srv.until(st => st.plans[0]?.state === 'done' && idle('lead')(st), '계획 끝남', 30000);
    const [promise, ...posts] = s.plans[0].board;
    assert.equal(promise.lead, true);
    assert.match(promise.text, /saveTodos/);
    assert.deepEqual(posts.map(b => b.who), ['일꾼 1', '일꾼 2']);
    assert.match(posts[0].text, /^1번 조각: 버튼 이름은 login \(약속 봄=true, 앞 소식 봄=false\)$/);
    assert.match(posts[1].text, /^2번 조각: .*약속 봄=true, 앞 소식 봄=true/);   // 뒤 조각은 앞 조각의 소식을 받았다
    const first = logOf(s, 'a1').find(e => e.k === 'user').text;
    assert.match(first, /\.team-board\.md/);   // 시작 전·끝내기 전에 게시판 파일을 다시 읽으라는 안내
    const file = fs.readFileSync(path.join(srv.home, 'work', '.team-board.md'), 'utf8');
    assert.match(file, /saveTodos/);
    assert.match(file, /2번 조각/);
    assert.match(s.plans[0].final, /게시판 봄/);   // 팀장이 최종 보고를 쓸 때 게시판을 받았다
  });
});

test('팀 게시판: 감독관이 돌려보내 고친 차례는 [게시판] 을 안 적었으면 올리지 않는다 (게시판이 어지럽지 않게)', async () => {
  const seedTeam = { settings: { lead: { enabled: true, approve: false }, supervisor: { enabled: true } }, agents: [{ id: 'a1', name: '일꾼 1' }, { id: 'a2', name: '일꾼 2' }] };
  await withServer({ seed: seedTeam }, async srv => {
    await srv.api('POST', '/api/send', { text: '할 일 앱 만들어 줘', target: 'lead' });
    const s = await srv.until(st => st.plans[0]?.state === 'done' && STAFF_IDLE.every(id => idle(id)(st)), '계획 끝남', 40000);
    // 가짜 감독관은 처음엔 고칠 점을 찾아 돌려보낸다 — 고친 차례의 답('고쳤어요.')은 올라가지 않는다
    assert.deepEqual(s.plans[0].board.slice(1).map(b => b.who).sort(), ['일꾼 1', '일꾼 2']);   // 두 조각은 동시에 돌아 끝나는 차례가 그때그때 다르다
    assert.ok(s.plans[0].board.every(b => !b.auto));
  });
});

test('팀 게시판: [게시판] 을 안 적은 답은 첫 줄을 자동 요약으로 올린다', async () => {
  const seedTeam = { settings: { lead: { enabled: true, approve: false } }, agents: [{ id: 'a1', name: '일꾼 1' }, { id: 'a2', name: '일꾼 2' }] };
  await withServer({ seed: seedTeam }, async srv => {
    await srv.api('POST', '/api/send', { text: '할 일 앱 게시판 없이 만들어 줘', target: 'lead' });   // 가짜 일꾼이 [게시판] 을 안 적는다
    const s = await srv.until(st => st.plans[0]?.state === 'done' && idle('lead')(st), '계획 끝남', 30000);
    const posts = s.plans[0].board.slice(1);
    assert.deepEqual(posts.map(b => b.who).sort(), ['일꾼 1', '일꾼 2']);   // 두 조각은 동시에 돌아 끝나는 차례가 그때그때 다르다
    for (const b of posts) {
      assert.equal(b.auto, true);
      assert.match(b.text, /^고쳤어요\./);
    }
  });
});

test('검사 자리 설정은 다시 켜도 그대로 남는다', async () => {
  const home = tempDir();
  seed(home);
  let srv = await startServer({ home });
  try {
    await srv.api('POST', '/api/settings', { lead: { enabled: true, approve: false, model: 'haiku' }, tester: { enabled: true, engine: 'codex' }, security: { enabled: true } });
    await srv.stop();
    srv = await startServer({ home });
    const s = await srv.state();
    assert.equal(s.settings.lead.enabled, true);
    assert.equal(s.settings.lead.approve, false);
    assert.equal(s.settings.lead.model, 'haiku');
    assert.equal(s.settings.tester.engine, 'codex');
    assert.equal(s.settings.security.enabled, true);
    assert.equal((await srv.raw('PATCH', '/api/agents/lead', { name: '바꾸기' })).status, 400);   // 관리하는 자리는 이름·설정을 직접 못 바꾼다
  } finally {
    await srv.stop();   // 확인이 실패해도 서버를 끈다 (안 끄면 시험이 끝나지 않는다)
    removeDir(home);
  }
});

// ───────────────────────── 팀장 ─────────────────────────

const TWO_WORKERS = [{ id: 'a1', name: '일꾼 1', role: '화면 담당' }, { id: 'a2', name: '일꾼 2', role: '서버 담당' }];

test('팀장: 계획을 먼저 보여 주고, 시작하면 일꾼들에게 나눠 맡긴 뒤 결과를 모아 보고한다', async () => {
  await withServer({ seed: { settings: { lead: { enabled: true } }, agents: TWO_WORKERS } }, async srv => {
    const r = await srv.api('POST', '/api/send', { text: '할 일 앱 만들어 줘', target: 'lead' });
    assert.deepEqual(r.sentTo, ['lead']);
    let s = await srv.until(st => st.plans[0]?.state === 'proposed', '계획이 나온다');
    const p = s.plans[0];
    assert.deepEqual(p.tasks.map(x => x.workerId), ['a1', 'a2']);
    assert.ok(s.agents.every(a => !a.current && !a.queue.length), '허락 전에는 아무도 일하지 않는다');
    await srv.api('POST', `/api/plans/${p.id}/start`);
    s = await srv.until(st => st.plans[0]?.state === 'done' && idle('lead')(st), '최종 보고');
    assert.deepEqual(s.plans[0].tasks.map(x => x.state), ['done', 'done']);
    assert.match(s.plans[0].final, /최종 보고/);
    assert.match(logOf(s, 'a1').find(e => e.k === 'user').text, /^\[팀장이 나눈 일 1\/2\] 빠르게 1번 조각/);
    assert.match(logOf(s, 'a2').find(e => e.k === 'user').text, /^\[팀장이 나눈 일 2\/2\] 빠르게 2번 조각/);
  });
});

test('팀장: 바로 시작하게 하면 허락 없이 맡기고, 감독관 검토가 다 끝난 뒤에 결과를 모은다', async () => {
  await withServer({ seed: { settings: { lead: { enabled: true, approve: false }, supervisor: { enabled: true } }, agents: TWO_WORKERS } }, async srv => {
    await srv.api('POST', '/api/send', { text: '할 일 앱 만들어 줘', target: 'lead' });
    const s = await srv.until(st => st.plans[0]?.state === 'done' && STAFF_IDLE.every(id => idle(id)(st)), '검토 뒤 최종 보고');
    assert.equal(s.reports.length, 2);
    assert.ok(s.reports.every(r => r.state === 'pass'));
    assert.deepEqual(s.plans[0].tasks.map(x => x.state), ['done', 'done']);
    // 조각은 검사가 끝난 때 끝나서, 팀장이 받은 결과에 검사 내용이 들어 있다 (검사 전에 끝내면 비어 있다)
    assert.ok(s.plans[0].tasks.every(x => /이름표/.test(x.review)), JSON.stringify(s.plans[0].tasks.map(x => x.review)));
  });
});

test('팀장: 계획을 취소하면 아무 일꾼도 일을 받지 않는다', async () => {
  await withServer({ seed: { settings: { lead: { enabled: true } }, agents: TWO_WORKERS } }, async srv => {
    await srv.api('POST', '/api/send', { text: '할 일 앱 만들어 줘', target: 'lead' });
    let s = await srv.until(st => st.plans[0]?.state === 'proposed', '계획이 나온다');
    await srv.api('POST', `/api/plans/${s.plans[0].id}/cancel`);
    s = await srv.state();
    assert.equal(s.plans[0].state, 'stopped');
    assert.deepEqual(s.plans[0].tasks.map(x => x.state), ['stopped', 'stopped']);
    assert.equal((await srv.raw('POST', `/api/plans/${s.plans[0].id}/start`)).status, 400);   // 취소한 계획은 다시 시작할 수 없다
    assert.ok(s.agents.every(a => !a.current && !a.queue.length));
  });
});

test('팀장: 나눈 일이 하나도 끝나지 못하면 결과를 모으지 않고 멈춘다 (사용량을 아낀다)', async () => {
  await withServer({ seed: { settings: { lead: { enabled: true, approve: false } }, agents: TWO_WORKERS } }, async srv => {
    await srv.api('POST', '/api/send', { text: '고장 날 일을 맡겨 줘', target: 'lead' });
    const s = await srv.until(st => st.plans[0]?.state === 'stopped' && idle('lead')(st) && idle('a1')(st) && idle('a2')(st), '계획이 멈춤');
    assert.deepEqual(s.plans[0].tasks.map(x => x.state), ['error', 'error']);
    assert.equal(s.plans[0].final, '');
    assert.equal(logOf(s, 'lead').filter(e => e.k === 'user').length, 1);   // 계획 세우기 한 번뿐, 결과 모으기는 하지 않았다
  });
});

test('팀장: 뒤 조각은 앞 조각이 검사까지 끝난 뒤에 시작하고, 앞 조각의 결과를 받는다', async () => {
  await withServer({ seed: { settings: { lead: { enabled: true, approve: false }, supervisor: { enabled: true } }, agents: TWO_WORKERS } }, async srv => {
    await srv.api('POST', '/api/send', { text: '순서 있는 일 맡겨 줘', target: 'lead' });
    const s = await srv.until(st => st.plans[0]?.state === 'done' && STAFF_IDLE.every(id => idle(id)(st)), '순서대로 끝남');
    const [first, second] = s.plans[0].tasks;
    assert.deepEqual(second.after, [first.id]);
    assert.deepEqual(s.plans[0].tasks.map(x => x.state), ['done', 'done']);
    // 둘째 일꾼은 첫째 조각의 검토가 통과한 뒤에야 일을 받았다
    const passAt = logOf(s, 'a1').find(e => e.k === 'sys' && /감독관 통과/.test(e.text)).t;
    const second0 = logOf(s, 'a2').find(e => e.k === 'user');
    assert.ok(second0.t >= passAt, `둘째 조각이 너무 일찍 시작했어요 (${second0.t} < ${passAt})`);
    assert.match(second0.text, /먼저 끝난 조각/);
    assert.match(second0.text, /일꾼 1/);
  });
});

test('팀장: 앞 조각이 끝나지 못하면 뒤 조각은 시작하지 않는다', async () => {
  await withServer({ seed: { settings: { lead: { enabled: true, approve: false } }, agents: TWO_WORKERS } }, async srv => {
    await srv.api('POST', '/api/send', { text: '순서 있는 일인데 기다려', target: 'lead' });
    let s = await srv.until(st => st.plans[0]?.state === 'running' && said(st, 'a1').includes('일하는 중이에요.'), '첫 조각이 일하는 중');
    assert.equal(s.plans[0].tasks[1].state, 'blocked');
    assert.ok(!agentOf(s, 'a2').current && !agentOf(s, 'a2').queue.length, '둘째 일꾼은 아직 일을 받지 않았다');
    await srv.api('POST', '/api/agents/a1/stop');
    s = await srv.until(st => st.plans[0]?.state === 'stopped' && idle('a1')(st), '계획이 멈춤');
    assert.deepEqual(s.plans[0].tasks.map(x => x.state), ['stopped', 'stopped']);
    assert.equal(logOf(s, 'a2').length, 0);
  });
});

test('팀장이 꺼져 있으면 팀장에게 보낼 수 없다', async () => {
  await withServer(async srv => {
    const r = await srv.raw('POST', '/api/send', { text: '할 일 앱 만들어 줘', target: 'lead' });
    assert.equal(r.status, 400);
  });
});

// ───────────────────────── ⇄ 다른 AI 에게 넘기기·인수인계 쪽지 ─────────────────────────

test('⇄ 일하는 중에 넘기면 하던 일을 멈추고, 새 AI 가 앞 AI 의 마지막 말이 든 쪽지를 받아 이어 한다', async () => {
  await withServer(async srv => {
    await send(srv, '기다려. 쪽지 보기');
    await srv.until(working('일하는 중이에요.'), 'Claude 가 일하는 중');
    assert.equal((await handover(srv, 'codex')).moved, 'running');
    const s = await srv.until(st => idle('a1')(st) && st.history.length === 2, 'GPT 가 넘겨받아 끝냄');
    assert.equal(agentOf(s, 'a1').engine, 'codex');
    assert.deepEqual(s.history.map(h => h.status), ['done', 'stopped']);   // 최신이 앞: GPT 완료 ← Claude 중지
    assert.match(note(s), /일하는 중이에요\./);
  });
});

test('⇄ 앞 AI 가 아직 멈추는 중에 또 넘겨도 같은 일이 두 번 들어가지 않는다', async () => {
  await withServer(async srv => {
    await send(srv, '기다려 천천히 멈춤');
    await srv.until(working('일하는 중이에요.'), 'Claude 가 일하는 중');
    assert.equal((await handover(srv, 'codex')).moved, 'running');
    assert.equal((await handover(srv, 'claude')).moved, 'running');
    const s = await srv.until(st => st.history.length === 1 && !!agentOf(st, 'a1').current, '멈춘 뒤 넘긴 일이 다시 시작됨');
    assert.equal(agentOf(s, 'a1').queue.length, 0);
    assert.equal(agentOf(s, 'a1').engine, 'claude');
  });
});

test('⇄ 오류로 막힌 일을 넘기면 새 AI 가 무엇이 문제였는지 든 쪽지를 받아 다시 한다', async () => {
  await withServer(async srv => {
    await send(srv, '고장. 쪽지 보기');
    await srv.until(st => idle('a1')(st) && agentOf(st, 'a1').last === 'error', 'Claude 가 오류로 끝남');
    assert.equal((await handover(srv, 'codex')).moved, 'failed');
    const s = await srv.until(st => idle('a1')(st) && st.history.length === 2, 'GPT 가 다시 함');
    assert.match(note(s), /API Error: 500/);
  });
});

test('⇄ 쉬는 중에 넘기면 다음 일부터 새 AI 가 맡고, 지난 일을 쪽지로 받는다', async () => {
  await withServer(async srv => {
    await send(srv, '빠르게 제목 고쳐 줘');
    await srv.until(st => idle('a1')(st) && st.history.length === 1, '첫 일이 끝남');
    assert.equal((await handover(srv, 'codex')).moved, null);
    await send(srv, '쪽지 보기');
    const s = await srv.until(st => idle('a1')(st) && st.history.length === 2, 'GPT 가 끝냄');
    assert.match(note(s), /빠르게 제목 고쳐 줘/);
  });
});

test('⇄ GPT 가 명령(Set-Content)으로 만든 파일도 쪽지에 들어간다', async () => {
  await withServer({ seed: { agents: [{ id: 'a1', name: '일꾼 1', engine: 'codex' }] } }, async srv => {
    await send(srv, '명령으로 쓰기. 쪽지 보기');
    await srv.until(st => logOf(st, 'a1').some(e => e.k === 'out' && e.text === '1'), 'GPT 가 명령으로 파일을 씀');
    assert.equal((await handover(srv, 'claude')).moved, 'running');
    const s = await srv.until(st => idle('a1')(st) && st.history.some(h => h.status === 'done'), 'Claude 가 넘겨받아 끝냄');
    assert.match(note(s), /Set-Content -LiteralPath 'gpt-made\.txt'/);
  });
});

test('⇄ 넘겨받은 AI 가 이어 할 대화를 잃어 새 대화로 다시 해도 쪽지를 다시 받는다', async () => {
  const lost = '00000000-0000-0000-0000-000000000000';   // 가짜 claude 는 이 대화를 이어 하지 못한다
  await withServer({ seed: { agents: [{ id: 'a1', name: '일꾼 1', engine: 'codex', lastAi: 'gpt', sessionId: lost }] } }, async srv => {
    await send(srv, '오래 걸리는 일. 쪽지 보기');
    await srv.until(st => logOf(st, 'a1').some(e => e.k === 'tool' && /Start-Sleep/.test(e.summary)), 'GPT 가 일하는 중');
    assert.equal((await handover(srv, 'claude')).moved, 'running');
    const s = await srv.until(st => idle('a1')(st) && st.history.some(h => h.status === 'done'), 'Claude 가 새 대화로 끝냄');
    assert.notEqual(agentOf(s, 'a1').sessionId, lost);
    assert.match(note(s), /오래 걸리는 일/);
  });
});

test('Claude 가 한도에 걸리면 쪽지와 함께 대체 AI 가 이어받고, 앞 일의 말과 결과는 쪽지에 섞이지 않는다', async () => {
  await withServer({ seed: FALLBACK_ON }, async srv => {
    await send(srv, '고장');   // 앞 일: '해 볼게요…' 라고 말한 뒤 'API Error: 500 …' 오류로 끝난다
    await srv.until(st => idle('a1')(st) && agentOf(st, 'a1').last === 'error', '앞 일이 오류로 끝남');
    await send(srv, '말없이 한도에 걸리는 일');
    const s = await srv.until(st => idle('a1')(st) && said(st, 'a1').some(t => t.startsWith('[대체 AI 모드]')), '대체 AI 가 이어받아 끝냄');
    const line = said(s, 'a1').find(t => t.startsWith('[대체 AI 모드]'));
    assert.equal(agentOf(s, 'a1').mode, 'fallback');
    assert.match(line, /쪽지: \[인수인계 쪽지\]/);
    assert.match(line, /말없이 한도에 걸리는 일/);
    assert.ok(!line.includes('해 볼게요'), line);
    assert.ok(!line.includes('API Error'), line);
  });
});

test('감독관이 돌려보낸 고치기가 오류로 막힌 뒤 ⇄ 로 넘기면 같은 보고 카드로 이어진다', async () => {
  await withServer({ seed: SUPERVISOR_ON }, async srv => {
    fs.writeFileSync(path.join(srv.home, 'work', 'FAIL_FIX'), '');   // 가짜 claude 가 고치기를 오류로 끝내게 한다
    await send(srv, '빠르게 제목 고쳐 줘');
    let s = await srv.until(st => st.reports[0]?.state === 'stopped' && idle('a1')(st) && agentOf(st, 'a1').last === 'error', '고치기가 오류로 막힘');
    const card = s.reports[0].id;
    assert.equal((await handover(srv, 'codex')).moved, 'failed');
    s = await srv.until(st => st.reports[0]?.state === 'pass' && idle('a1')(st) && idle('supervisor')(st), '넘긴 고치기가 통과');
    assert.deepEqual(s.reports.map(r => r.id), [card]);
    assert.deepEqual(s.reports[0].steps.map(x => `${x.round}:${x.verdict}`), ['0:fix', '1:pass']);
  });
});

test('막힌 고치기는 관제실을 껐다 켠 뒤에 넘겨도 같은 보고 카드로 이어진다', async () => {
  const home = tempDir();
  fs.writeFileSync(path.join(seed(home, SUPERVISOR_ON), 'FAIL_FIX'), '');
  let srv = await startServer({ home });
  try {
    await send(srv, '빠르게 제목 고쳐 줘');
    let s = await srv.until(st => st.reports[0]?.state === 'stopped' && idle('a1')(st) && agentOf(st, 'a1').last === 'error', '고치기가 오류로 막힘');
    const card = s.reports[0].id;
    await srv.stop();
    srv = await startServer({ home });
    assert.equal((await handover(srv, 'codex')).moved, 'failed');
    s = await srv.until(st => st.reports[0]?.state === 'pass' && idle('a1')(st) && idle('supervisor')(st), '넘긴 고치기가 통과');
    assert.deepEqual(s.reports.map(r => r.id), [card]);
  } finally {
    await srv.stop();
    removeDir(home);
  }
});

// ───────────────────────── 파일 첨부 ─────────────────────────

const upload = (srv, name, body, token = srv.token) => fetch(`${srv.base}/api/attachments?name=${encodeURIComponent(name)}`, {
  method: 'POST', headers: { 'x-token': token, 'Content-Type': 'application/octet-stream' }, body,
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

test('첨부: 올린 파일은 보낼 때 그 일꾼의 작업 폴더 attachments 에 들어가고, 시킨 일 글에 경로가 붙는다', async () => {
  await withServer(async srv => {
    const up = await upload(srv, '메모.txt', '안녕 첨부');
    assert.equal(up.status, 200);
    assert.equal(up.body.name, '메모.txt');
    await srv.api('POST', '/api/send', { text: '빠르게 메모 보고 고쳐 줘', target: ['a1'], attachments: [up.body.id] });
    const s = await srv.until(st => idle('a1')(st) && logOf(st, 'a1').some(e => e.k === 'done'), '일 끝남');
    const file = path.join(srv.home, 'work', 'attachments', '메모.txt');
    assert.equal(fs.readFileSync(file, 'utf8'), '안녕 첨부');
    assert.match(logOf(s, 'a1').find(e => e.k === 'user').text, /attachments\/메모\.txt/);
    assert.equal((await srv.raw('POST', '/api/send', { text: '또', target: ['a1'], attachments: [up.body.id] })).status, 400);   // 한 번 보낸 첨부는 다시 못 쓴다
  });
});

test('첨부: 파일 이름으로 작업 폴더 밖에 쓰거나 윈도 예약 이름을 쓸 수 없다', async () => {
  await withServer(async srv => {
    const ids = [];
    for (const name of ['..\\..\\evil.txt', '../../evil2.txt', 'CON.txt', 'a<b>:c?.txt']) ids.push((await upload(srv, name, 'x')).body.id);
    await srv.api('POST', '/api/send', { text: '빠르게 봐 줘', target: ['a1'], attachments: ids });
    await srv.until(st => idle('a1')(st) && logOf(st, 'a1').some(e => e.k === 'done'), '일 끝남');
    const dir = path.join(srv.home, 'work', 'attachments');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['_CON.txt', 'a_b__c_.txt', 'evil.txt', 'evil2.txt']);
    assert.ok(!fs.existsSync(path.join(srv.home, 'evil.txt')) && !fs.existsSync(path.join(srv.home, 'work', 'evil.txt')));
  });
});

test('관제실을 또 켜면 이미 켜진 쪽이 한 번만 쓰는 새 주소로 창을 연다 (올려 둔 첨부도 지우지 않는다)', async () => {
  await withServer(async srv => {
    const up = await upload(srv, 'a.txt', 'hi');
    const again = spawn(process.execPath, [SERVER, '--no-open', '--no-ccr', '--port', String(srv.port), '--home', srv.home], { stdio: 'ignore', windowsHide: true });
    await new Promise(resolve => again.once('exit', resolve));
    await waitFor(() => bootCodes(srv.output()).length >= 2, '이미 켜진 쪽이 새 주소를 찍음');   // --no-open 이라 창 대신 주소를 찍는다
    assert.equal(await enter(srv.base, bootCodes(srv.output())[1]), srv.cookie);
    await srv.api('POST', '/api/send', { text: '빠르게 봐 줘', target: ['a1'], attachments: [up.body.id] });
  });
});

test('첨부: 열쇠가 없으면 올릴 수 없고, 너무 큰 파일은 받지 않는다', async () => {
  await withServer(async srv => {
    assert.equal((await upload(srv, 'a.txt', 'x', 'wrong')).status, 401);
    const big = await upload(srv, 'big.bin', Buffer.alloc(26 * 1024 * 1024));
    assert.equal(big.status, 413);
  });
});

test('첨부: GPT 에이전트에게는 사진을 이미지로도 같이 넘긴다', async () => {
  await withServer({ seed: { agents: [{ id: 'a1', name: '일꾼 1', engine: 'codex' }] } }, async srv => {
    const png = await upload(srv, 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const txt = await upload(srv, 'notes.txt', 'n');
    await srv.api('POST', '/api/send', { text: '설정 보기', target: ['a1'], attachments: [png.body.id, txt.body.id] });
    const s = await srv.until(st => said(st, 'a1').some(x => x.includes('images=')), 'GPT 가 답함');
    assert.match(said(s, 'a1').find(x => x.includes('images=')), /images=shot\.png(?!,)/);   // 사진만, notes.txt 는 빼고
  });
});

test('첨부: 팀장에게 보내면 일꾼들의 작업 폴더마다 같은 자리에 넣어 둔다', async () => {
  const home = tempDir();
  const other = path.join(home, 'other');
  fs.mkdirSync(other, { recursive: true });
  seed(home, { settings: { lead: { enabled: true } }, agents: [{ id: 'a1', name: '일꾼 1' }, { id: 'a2', name: '일꾼 2', cwd: other }] });
  const srv = await startServer({ home });
  try {
    const up = await upload(srv, 'spec.md', '# 할 일');
    await srv.api('POST', '/api/send', { text: '할 일 앱 만들어 줘', target: 'lead', attachments: [up.body.id] });
    for (const dir of [path.join(home, 'work'), other]) assert.equal(fs.readFileSync(path.join(dir, 'attachments', 'spec.md'), 'utf8'), '# 할 일');
  } finally {
    await srv.stop();
    removeDir(home);
  }
});

// ───────────────────────── 결과 미리 보기 ─────────────────────────

const previewBase = s => `http://127.0.0.1:${s.app.preview.port}/p/${s.app.preview.key}`;
const rawGet = (port, p, host) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: host ? { Host: host } : {} }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  }).on('error', reject);
});

test('미리 보기: 일꾼이 고친 웹 페이지를 기록에 붙이고, 관제실과 다른 주소에서 바깥 연결을 막은 채 보여 준다', async () => {
  await withServer(async srv => {
    fs.writeFileSync(path.join(srv.home, 'work', 'index.html'), '<!doctype html><button>로그인</button>');
    let s = await srv.until(st => st.app.preview, '미리 보기 서버가 켜짐');
    assert.notEqual(s.app.preview.port, srv.port);   // 같은 주소면 그 페이지가 관제실 화면에 손댈 수 있다
    await send(srv, '빠르게 버튼 고쳐 줘');
    s = await srv.until(st => st.history[0]?.status === 'done', '일 끝남');
    assert.equal(s.history[0].preview, 'index.html');
    const res = await fetch(`${previewBase(s)}/a1/index.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.match(res.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal(await res.text(), '<!doctype html><button>로그인</button>');
    // 웹 페이지를 고치지 않은 일에는 붙이지 않는다
    await send(srv, '설정 보기');
    s = await srv.until(st => st.history.length === 2 && st.history[0].status === 'done', '두 번째 일 끝남');
    assert.equal(s.history[0].preview, undefined);
  });
});

test('미리 보기: 번호가 틀리거나, 작업 폴더 밖(.. ·정션)이거나, 내 PC 주소가 아니면 주지 않는다', async () => {
  await withServer(async srv => {
    const work = path.join(srv.home, 'work');
    fs.writeFileSync(path.join(work, 'index.html'), 'ok');
    fs.writeFileSync(path.join(srv.home, 'secret.txt'), 'SECRET');
    fs.mkdirSync(path.join(srv.home, 'outside'));
    fs.writeFileSync(path.join(srv.home, 'outside', 'x.txt'), 'SECRET');
    fs.symlinkSync(path.join(srv.home, 'outside'), path.join(work, 'link'), 'junction');
    const s = await srv.until(st => st.app.preview, '미리 보기 서버가 켜짐');
    const { port, key } = s.app.preview;
    assert.equal((await rawGet(port, `/p/${key}/a1/index.html`)).status, 200);
    assert.equal((await rawGet(port, `/p/${key}/a1/`)).body, 'ok');   // 폴더면 그 안의 index.html
    for (const p of [`/p/${'0'.repeat(key.length)}/a1/index.html`, `/p/${key}/nobody/index.html`, `/p/${key}/a1/../secret.txt`,
      `/p/${key}/a1/..%2f..%2fsecret.txt`, `/p/${key}/a1/..%5csecret.txt`, `/p/${key}/a1/link/x.txt`]) {
      const r = await rawGet(port, p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes('SECRET'), p);
    }
    assert.equal((await rawGet(port, `/p/${key}/a1/index.html`, 'evil.example')).status, 403);
    // \\서버\… 경로는 파일 시스템에 묻기만 해도 윈도가 그 서버에 접속한다 (로그인 정보가 새고, 기다리는 동안 서버가 멈춘다).
    // 폴더 밖이라는 걸 먼저 알아채고 바로 거절해야 한다. 192.0.2.1 은 아무도 없는 문서용 주소라, 접속하려 들면 한참 걸린다
    for (const p of [`/p/${key}/a1/%5C%5C192.0.2.1%5Cshare%5Cx.html`, `/p/${key}/a1///192.0.2.1/share/x.html`]) {
      const t0 = Date.now();
      assert.equal((await rawGet(port, p)).status, 404, p);
      assert.ok(Date.now() - t0 < 1500, `${p}: ${Date.now() - t0}ms 걸림 — 네트워크 경로에 접속하려 든 것 같다`);
    }
  });
});

test('미리 보기: 관제실 화면은 미리 보기 서버 말고는 틀(iframe)에 띄우지 못하게 하고, 미리 보는 페이지는 DNS 미리 조회를 끈다', async () => {
  await withServer(async srv => {
    fs.writeFileSync(path.join(srv.home, 'work', 'index.html'), 'ok');
    const s = await srv.until(st => st.app.preview, '미리 보기 서버가 켜짐');
    const page = await fetch(`${srv.base}/`, { headers: { cookie: srv.cookie } });
    // 미리 보는 페이지가 스스로 바깥 주소로 옮겨 가며 내용을 실어 보내는 길을 막는다 (틀 안의 이동도 이 규칙을 따른다)
    assert.equal(page.headers.get('content-security-policy'), `frame-src http://127.0.0.1:${s.app.preview.port} http://localhost:${s.app.preview.port}`);
    const pv = await fetch(`${previewBase(s)}/a1/index.html`);
    assert.equal(pv.headers.get('x-dns-prefetch-control'), 'off');
  });
});

// ───────────────────────── 설정·진단 정보 ─────────────────────────

test('알림·효과 설정을 바꾸면 관제실을 다시 켜도 그대로다', async () => {
  const home = tempDir();
  seed(home);
  let srv = await startServer({ home });
  try {
    await srv.api('POST', '/api/settings', { notify: true, effects: false });
    await srv.stop();
    srv = await startServer({ home });
    const { settings } = await srv.state();
    assert.equal(settings.notify, true);
    assert.equal(settings.effects, false);
  } finally {
    await srv.stop();
    removeDir(home);
  }
});

test('화면이 받는 상태에 앱 버전(package.json)이 들어 있다', async () => {
  await withServer(async srv => {
    assert.equal((await srv.state()).app.version, APP_VERSION);
  });
});

test('진단 정보에는 버전·에이전트 상태·최근 오류가 들어가고, 열쇠·시킨 일·사용자 폴더 이름은 들어가지 않는다', async () => {
  await withServer({ seed: { settings: { fallbackKey: 'sk-secret-123' } } }, async srv => {
    await send(srv, '고장 비밀프롬프트');   // 'API Error: 500 …' 오류로 끝나는 일
    await srv.until(st => idle('a1')(st) && agentOf(st, 'a1').last === 'error', '오류로 끝남');
    const d = await srv.api('GET', '/api/diagnostics');
    assert.equal(d.app.version, APP_VERSION);
    assert.equal(d.node, process.version);
    assert.equal(d.agents.find(a => a.name === '일꾼 1').last, 'error');
    const strings = [];
    JSON.stringify(d, (key, value) => { if (typeof value === 'string') strings.push(value); return value; });
    assert.ok(strings.some(v => v.includes('API Error: 500')), '최근 오류가 들어 있다');
    for (const hidden of ['sk-secret-123', '비밀프롬프트', os.homedir()]) {
      assert.deepEqual(strings.filter(v => v.includes(hidden)), [], `'${hidden}' 이 들어가면 안 된다`);
    }
  });
});

// ───────────────────────── 언어·저장 위치·처음 켜기 ─────────────────────────

test('언어를 영어로 바꾸면 기본 이름, 에이전트 안내문, 화면, 오류 글이 영어가 된다', async () => {
  await withServer({ seed: { agents: [{ id: 'a1', name: '클로드 1' }] } }, async srv => {
    await srv.api('POST', '/api/settings', { lang: 'en' });
    let s = await srv.state();
    assert.equal(agentOf(s, 'a1').name, 'Claude 1');
    assert.equal(s.supervisor.name, 'Supervisor');
    await send(srv, '설정 보기');   // 가짜 claude 가 받은 안내문 첫 줄을 note= 뒤에 그대로 말한다
    s = await srv.until(st => idle('a1')(st) && st.history.length === 1, '일이 끝남');
    assert.match(said(s, 'a1')[0], /note=You are/);
    assert.match(await (await fetch(`${srv.base}/`)).text(), /<html lang="en">/);
    const bad = await srv.raw('POST', '/api/send', { text: '' });
    assert.equal(bad.status, 400);
    assert.ok(!/[가-힣]/.test(bad.body.error), bad.body.error);
  });
});

test('기록 폴더를 옮기면 새 폴더에 쓰고 예전 파일은 지우며, 다시 켜도 옮긴 곳에서 읽는다', async () => {
  const home = tempDir();
  seed(home);
  let srv = await startServer({ home });
  try {
    const dest = path.join(home, 'elsewhere');
    await srv.api('PATCH', '/api/agents/a1', { name: '옮긴 일꾼' });
    await srv.api('POST', '/api/data-dir', { dir: dest });
    assert.equal((await srv.state()).app.dataDir, dest);
    assert.ok(fs.existsSync(path.join(dest, 'state.json')));
    assert.ok(!fs.existsSync(path.join(home, 'data', 'state.json')));
    await srv.stop();
    srv = await startServer({ home });
    assert.equal(agentOf(await srv.state(), 'a1').name, '옮긴 일꾼');
  } finally {
    await srv.stop();
    removeDir(home);
  }
});

test('이미 관제실 기록이 있는 폴더로는 기록 폴더를 옮기지 않는다', async () => {
  await withServer(async srv => {
    const taken = path.join(srv.home, 'taken');
    fs.mkdirSync(taken);
    fs.writeFileSync(path.join(taken, 'state.json'), '{"agents":[{"id":"남의것"}]}');
    assert.equal((await srv.raw('POST', '/api/data-dir', { dir: taken })).status, 400);
    assert.equal((await srv.state()).app.dataDir, path.join(srv.home, 'data'));
    assert.equal(fs.readFileSync(path.join(taken, 'state.json'), 'utf8'), '{"agents":[{"id":"남의것"}]}');
  });
});

test('처음 켜면 설정이 안 끝난 상태이고, /api/setup 이 언어·작업 폴더·기록 폴더를 한 번에 정한다', async () => {
  await withServer({ seed: false }, async srv => {
    assert.equal((await srv.state()).settings.setupDone, false);
    const work = path.join(srv.home, 'my work');
    const data = path.join(srv.home, 'my data');
    await srv.api('POST', '/api/setup', { lang: 'en', defaultCwd: work, dataDir: data });
    const s = await srv.state();
    assert.equal(s.settings.setupDone, true);
    assert.equal(s.agents[0].name, 'Claude 1');
    assert.deepEqual([...new Set(s.agents.map(a => a.cwd))], [work]);
    assert.ok(fs.statSync(work).isDirectory());
    assert.equal(s.app.dataDir, data);
  });
});
