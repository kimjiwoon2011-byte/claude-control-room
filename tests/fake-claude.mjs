// 시험용 가짜 claude — 진짜 Claude Code 의 stream-json 대화(-p --input-format/--output-format stream-json)를 흉내 낸다.
// 진짜 AI 를 부르지 않아서 사용량이 들지 않는다. 받은 글에 든 낱말에 따라 정해진 대로 움직인다:
//
//   설정 보기        받은 실행 옵션과 안내문 첫 줄을 그대로 말하고 끝낸다
//   쪽지 보기        글 앞에 인수인계 쪽지가 붙어 있으면 그 쪽지를 그대로 말하고 끝낸다
//   빠르게 / quick   허락 없이 파일 하나를 고치고 끝낸다 (감독관이 돌려보낸 일도 이렇게 한다)
//   기다려           한마디 하고, 멈추라고 할 때까지 일하는 척한다 ('천천히 멈춤'이 같이 있으면 멈추는 데 0.7초 걸린다)
//   한도             Claude 사용량 한도에 걸린다 ('말없이'가 같이 있으면 아무 말도 하기 전에 걸린다)
//   로그인 오류      로그인이 풀린 오류를 낸다
//   고장             한도·로그인과 상관없는 오류를 낸다
//   [검토 요청] …    감독관 노릇: 처음엔 고칠 점을 찾고, 고친 뒤에는 통과시킨다
//   [보안 검사 요청] 보안 검사관 노릇: 작업 폴더에 LEAK 파일이 있으면 처음엔 고칠 점을 찾고, 고친 뒤에는 통과시킨다
//   [시험 요청] …    테스터 노릇: 받은 권한·도구를 말하고 `npm test` 허락을 구한 뒤 통과시킨다
//   [계획 요청] …    팀장 노릇: 글에 적힌 일꾼 앞쪽 두 명에게 '빠르게' 일을 하나씩 나눠 준다 ('기다려'·'고장'이 있으면 그 일,
//                    '순서'가 있으면 둘째 조각은 첫째 조각이 끝난 뒤에 하게 after 를 붙인다)
//   [결과 모으기] …  팀장 노릇: '최종 보고'를 올린다
//   (그 밖)          파일을 살펴보고 고친 뒤, `npm test` 를 돌려도 되는지 허락을 구한다
//
// 그 밖에: 작업 폴더에 FAIL_FIX 파일이 있으면 검사하는 자리가 돌려보낸 일이 오류로 끝난다.
//          --resume 00000000… 은 '이어 할 대화가 없음'으로 끝난다. ANTHROPIC_BASE_URL 이 있으면 대체 AI 인 척한다.
//          FAKE_FAST=1 이면 뜸 들이는 시간을 줄인다 (자동 시험용).
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const FAST = !!process.env.FAKE_FAST;
const sleep = ms => new Promise(r => setTimeout(r, FAST ? Math.min(ms, 12) : ms));
const hold = ms => new Promise(r => setTimeout(r, ms));   // FAKE_FAST 여도 줄이지 않는 기다림

if (args[0] === '--version') { console.log('2.1.294 (Fake Claude)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }, null, 2)); process.exit(0); }
if (args[0] === 'auth') { console.log('fake login'); process.exit(0); }

const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const model = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' }[opt('--model')] || 'claude-sonnet-5-5';
const mode = opt('--permission-mode') || 'default';
const resume = opt('--resume');
if (resume && resume.startsWith('00000000')) {   // 없는 대화를 이어 하려는 경우
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: resume, usage: {} });
  process.exit(1);
}
const sessionId = resume || randomUUID();
const base = { session_id: sessionId, parent_tool_use_id: null };
let inited = false;
let busy = false;
let interrupted = false;
const queue = [];
const pendingPerm = new Map();

async function step(ms) {
  await sleep(ms);
  if (interrupted) throw new Error('interrupted');
}

async function say(text) {
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, ...base });
  const size = FAST ? 60 : 3;
  for (let i = 0; i < text.length; i += size) {
    await step(35 + Math.random() * 45);
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } }, ...base });
  }
  out({ type: 'assistant', message: { model, content: [{ type: 'text', text }] }, ...base });
}

async function useTool(name, input) {
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name, id: 'x', input: {} } }, ...base });
  await step(500 + Math.random() * 900);
  const id = `toolu_${randomUUID().slice(0, 8)}`;
  out({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id, name, input }] }, ...base });
  return id;
}

function toolResult(id, content, isError = false) {
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...base });
}

async function tool(name, input, result) {
  const id = await useTool(name, input);
  await step(300 + Math.random() * 700);
  toolResult(id, result);
}

// 허락이 필요한 도구: 서버(화면)에 물어보고 답을 기다린다
async function ask(name, input) {
  const id = await useTool(name, input);
  const requestId = randomUUID();
  out({ type: 'control_request', request_id: requestId, request: {
    subtype: 'can_use_tool', tool_name: name, input, tool_use_id: id,
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: name, ruleContent: input.command }], behavior: 'allow', destination: 'localSettings' }],
  } });
  const decision = await new Promise(res => pendingPerm.set(requestId, res));
  if (interrupted) throw new Error('interrupted');
  return { id, decision };
}

const ok = (result, usage = { input_tokens: 200, output_tokens: 40 }, turns = 2) =>
  out({ type: 'result', subtype: 'success', is_error: false, result, session_id: sessionId, num_turns: turns, usage });
const fail = (result, extra = {}) =>
  out({ type: 'result', subtype: 'success', is_error: true, result, session_id: sessionId, usage: {}, num_turns: 1, ...extra });

// 글 앞에 붙은 인수인계 쪽지 (첫 '## ' 줄까지)
function noteOf(prompt) {
  if (!/^\[(인수인계 쪽지|Handoff note)\]/.test(prompt)) return '';
  const m = /^## .*$/m.exec(prompt);
  return m ? prompt.slice(0, m.index + m[0].length) : prompt;
}

async function work(prompt) {
  const note = noteOf(prompt);
  const fixRound = /^\[[^\]\n]*(?:수정 요청|fix request) \d/i.test(prompt);   // 감독관·보안 검사관·테스터가 돌려보낸 일
  const file = path.join(process.cwd(), 'index.html');

  if (prompt.includes('설정 보기')) {
    const sys = String(opt('--append-system-prompt') || '').split('\n')[0];
    const text = `model=${opt('--model') || '-'} effort=${opt('--effort') || '-'} permission=${mode} settings=${opt('--settings') || '-'} resume=${resume || '-'} note=${sys}`;
    await say(text);
    if (/"fastMode":\s*true/.test(opt('--settings') || '')) {
      out({ type: 'system', subtype: 'notification', key: 'fast-test', text: 'Fast mode disabled · usage credits turned off for your account', priority: 'immediate', color: 'error' });
    }
    return ok(text, { input_tokens: 20, output_tokens: 10 }, 1);
  }
  if (process.env.ANTHROPIC_BASE_URL) {   // 대체 AI 로 켜졌을 때: 받은 연결 정보와 쪽지를 그대로 말해 준다
    await say(`[대체 AI 모드] 주소=${process.env.ANTHROPIC_BASE_URL} 열쇠=${process.env.ANTHROPIC_API_KEY ? '있음' : '없음'} 모델=${opt('--model') || '-'} 쪽지: ${note || '없음'}`);
    return ok('대체 AI 가 마쳤어요.', { input_tokens: 50, output_tokens: 30 }, 1);
  }
  if (note && prompt.includes('쪽지 보기')) {
    await say(`쪽지: ${note}`);
    return ok('쪽지를 읽었어요.', { input_tokens: 30, output_tokens: 10 }, 1);
  }
  if (/^\[(검토 요청|Review request)\]/.test(prompt)) {
    await say('일꾼이 고친 파일을 읽어 볼게요.');
    await tool('Read', { file_path: file }, '1\t<!doctype html>\n2\t<button>로그인</button>');
    const fixed = /번째 수정|fix #/.test(prompt);
    const verdict = fixed
      ? { verdict: 'pass', work: 'index.html 의 버튼에 이름표까지 붙였어요.', summary: '버튼 이름표가 잘 들어갔어요.', fix: '' }
      : { verdict: 'fix', work: 'index.html 의 버튼을 고쳤어요.', summary: '로그인 버튼에 이름표(aria-label)가 없어요.', fix: 'index.html 의 로그인 버튼에 aria-label="로그인" 을 붙여 줘.' };
    const text = `${fixed ? '수정한 부분을 확인했어요.' : '버튼에 이름표가 빠져 있어요.'}\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``;
    await say(text);
    return ok(text, { input_tokens: 300, output_tokens: 80 });
  }
  if (/^\[(보안 검사 요청|Security check request)\]/.test(prompt)) {
    await tool('Read', { file_path: file }, '1\t<!doctype html>');
    const leak = existsSync(path.join(process.cwd(), 'LEAK')) && !/번째 수정|fix #/.test(prompt);
    const verdict = leak
      ? { verdict: 'fix', work: 'index.html 을 고쳤어요.', summary: '코드에 열쇠가 그대로 들어 있어요.', fix: '코드에 적힌 열쇠를 지우고 설정 파일에서 읽어 줘.' }
      : { verdict: 'pass', work: '', summary: '보안 문제는 없어요.', fix: '' };
    const text = `${leak ? '열쇠가 보여요.' : '위험한 점은 없어요.'}\n${JSON.stringify(verdict)}`;
    await say(text);
    return ok(text, { input_tokens: 200, output_tokens: 50 });
  }
  if (/^\[(시험 요청|Test request)\]/.test(prompt)) {
    await say(`permission=${mode} tools=${opt('--tools') || '-'} lean=${args.includes('--strict-mcp-config') && args.includes('--disable-slash-commands')}`);
    const { id, decision } = await ask('Bash', { command: 'npm test', description: '시험 돌리기' });
    const allowed = decision.behavior === 'allow';
    if (allowed) toolResult(id, '✓ 3 tests passed');
    else toolResult(id, "The user doesn't want to proceed with this tool use.", true);
    const verdict = { verdict: 'pass', work: '', summary: allowed ? '시험 3개가 모두 통과했어요.' : '허락을 못 받아 시험을 돌리지 못했어요.', fix: '' };
    const text = `시험을 마쳤어요.\n${JSON.stringify(verdict)}`;
    await say(text);
    return ok(text, { input_tokens: 200, output_tokens: 50 });
  }
  if (/^\[(계획 요청|Plan request)\]/.test(prompt)) {
    const names = [...prompt.matchAll(/^- ([^·\n]+?) · /gm)].map(m => m[1]).slice(0, 2);
    const request = (/## (?:사용자가 시킨 일|Task the user gave)\n([\s\S]*?)\n\n/.exec(prompt) || [])[1] || '';   // 규칙 글이 아니라 사용자가 시킨 일만 본다
    const job = request.includes('기다려') ? '기다려' : request.includes('고장') ? '고장' : request.includes('게시판 없이') ? '빠르게 게시판없이' : '빠르게';
    const plan = { plan: `${names.length}명에게 나눠 맡겨요.`, promises: '저장 함수는 saveTodos(todos) 로 맞춰요', tasks: names.map((worker, i) => ({ worker, task: `${job} ${i + 1}번 조각 만들어 줘` })) };
    if (request.includes('순서') && plan.tasks[1]) plan.tasks[1].after = [1];   // 둘째 조각은 첫째 조각이 끝난 뒤에
    const text = `계획을 세웠어요.\n${JSON.stringify(plan)}`;
    await say(text);
    return ok(text, { input_tokens: 300, output_tokens: 80 });
  }
  if (/^\[(결과 모으기|Collect results)\]/.test(prompt)) {
    const text = `최종 보고: 모두 끝났어요.${prompt.includes('saveTodos') ? ' (게시판 봄)' : ''}`;
    await say(text);
    return ok(text, { input_tokens: 300, output_tokens: 60 });
  }
  if (fixRound && existsSync(path.join(process.cwd(), 'FAIL_FIX'))) {
    await say('고쳐 볼게요…');
    return fail('API Error: 500 시험용 서버 오류');
  }
  if (/빠르게|quick/i.test(prompt) || fixRound) {
    await say('바로 고칠게요.');
    await tool('Edit', { file_path: file, old_string: '<button>', new_string: '<button class="login">' }, 'The file has been updated.');
    await say('고쳤어요.');
    // 팀장이 나눈 조각이면 팀 게시판에 소식을 올린다 (받은 글에 약속·앞 조각 소식이 들어 있었는지도 같이 적는다)
    const piece = /\[(?:팀장이 나눈 일|Task) (\d+)\/\d+/.exec(prompt);
    if (piece && !prompt.includes('게시판없이')) return ok(`고쳤어요.\n[게시판]\n${piece[1]}번 조각: 버튼 이름은 login (약속 봄=${prompt.includes('saveTodos')}, 앞 소식 봄=${/1번 조각: 버튼/.test(prompt)})`);
    return ok('고쳤어요.');
  }
  if (prompt.includes('기다려')) {
    await say('일하는 중이에요.');
    while (!interrupted) await hold(25);
    if (prompt.includes('천천히 멈춤')) await hold(700);
    throw new Error('interrupted');
  }
  if (prompt.includes('한도')) {
    if (!prompt.includes('말없이')) await say('작업을 시작할게요…');
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' }, session_id: sessionId });
    out({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your usage limit · resets 5pm" }] }, ...base });
    return fail("You've hit your usage limit · resets 5pm", { api_error_status: 429 });
  }
  if (prompt.includes('로그인 오류')) {
    await step(400);
    const text = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    out({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] }, ...base });
    return fail(text);
  }
  if (prompt.includes('고장')) {
    await say('해 볼게요…');
    return fail('API Error: 500 시험용 서버 오류');
  }

  await say(`좋아요! "${prompt.slice(0, 24)}" 작업을 시작할게요. 먼저 폴더 구조를 살펴볼게요.`);
  await tool('TodoWrite', { todos: [
    { content: '폴더 구조 살펴보기', status: 'completed' },
    { content: 'index.html 고치기', status: 'in_progress' },
    { content: '테스트 돌리기', status: 'pending' },
  ] }, 'Todos have been modified successfully.');
  await tool('Glob', { pattern: '**/*.html' }, 'index.html\nstyle.css\napp.js');
  await tool('Read', { file_path: file }, '1\t<!doctype html>\n2\t<html>\n3\t<body>\n4\t</body>\n5\t</html>');
  await say('구조를 파악했어요. 이제 `index.html` 을 고칠게요.');
  await tool('Edit', { file_path: file, old_string: '<body>', new_string: '<body class="app">' }, 'The file has been updated.');
  const { id, decision } = await ask('Bash', { command: 'npm test', description: '테스트 실행' });
  const allowed = decision.behavior === 'allow';
  if (allowed) toolResult(id, '> app@1.0.0 test\n> node test.js\n\n✓ 3 tests passed');
  else toolResult(id, "The user doesn't want to proceed with this tool use.", true);
  await step(300);
  await say(allowed ? '테스트도 모두 통과했어요. **완료!**' : '명령 실행을 거절하셔서 테스트는 건너뛰었어요.');
  ok(allowed ? '페이지를 고치고 테스트까지 마쳤어요.\n\n- `index.html` 수정\n- 테스트 3개 통과' : '페이지를 고쳤어요. 테스트는 건너뛰었어요.',
    { input_tokens: 1200, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 640 }, 6);
}

async function run() {
  if (busy || !queue.length) return;
  busy = true;
  interrupted = false;
  const prompt = String(queue.shift());
  if (!inited) {
    inited = true;
    // 빠른 모드를 켜 달라고 해도, 사용량 크레딧이 꺼진 계정처럼 보통 속도로 돈다
    const fastAsked = /"fastMode":\s*true/.test(opt('--settings') || '');
    out({ type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode: mode === 'manual' ? 'default' : mode, cwd: process.cwd(), tools: [],
      fast_mode_state: 'off', ...(fastAsked ? { fast_mode_disabled_reason: 'extra_usage_disabled' } : {}) });
  }
  try {
    await work(prompt);
  } catch {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, num_turns: 1, usage: {} });
  } finally {
    busy = false;
    setImmediate(run);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    if (msg.request?.subtype === 'interrupt') {
      interrupted = true;
      for (const [rid, res] of pendingPerm) { pendingPerm.delete(rid); res({ behavior: 'deny' }); }
    }
  } else if (msg.type === 'control_response') {
    const rid = msg.response?.request_id;
    const res = pendingPerm.get(rid);
    if (res) { pendingPerm.delete(rid); res(msg.response.response); }
  } else if (msg.type === 'user') {
    queue.push(msg.message.content);
    run();
  }
});
rl.on('close', () => {   // 서버가 꺼지거나 이 프로세스를 닫으면 하던 척을 그만두고 끝낸다
  interrupted = true;
  setTimeout(() => process.exit(0), 200);
});
