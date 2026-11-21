// 시험용 가짜 codex — 진짜 `codex exec --json` 이 내는 이벤트를 흉내 낸다 (GPT 에이전트 시험용).
// 진짜 AI 를 부르지 않아서 사용량이 들지 않는다. 받은 글에 든 낱말에 따라 정해진 대로 움직인다:
//
//   설정 보기        받은 실행 옵션(샌드박스·모델 등)을 그대로 말하고 끝낸다
//   쪽지 보기        글에 인수인계 쪽지가 들어 있으면 그 쪽지를 그대로 말하고 끝낸다
//   [검토 요청] …    감독관 노릇: 처음엔 고칠 점을 찾고, 고친 뒤에는 통과시킨다
//   GPT한도          사용량 한도 오류를 낸다
//   오래             끝나지 않는 명령을 돌린다 (멈추기·넘기기 시험용, 30초)
//   명령으로 쓰기    진짜 GPT 처럼 파일 편집 대신 명령(Set-Content)으로 gpt-made.txt 를 만들고, 일하는 척 머문다
//   (그 밖)          파일을 살펴보고 index.html 을 고친다 (읽기 전용 샌드박스면 고치지 않는다)
//
// FAKE_FAST=1 이면 뜸 들이는 시간을 줄인다 (자동 시험용).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const FAST = !!process.env.FAKE_FAST;
const sleep = ms => new Promise(r => setTimeout(r, FAST ? Math.min(ms, 12) : ms));
const hold = ms => new Promise(r => setTimeout(r, ms));   // FAKE_FAST 여도 줄이지 않는 기다림

if (args[0] === '--version') { console.log('codex-cli 0.166.0 (fake)'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { process.stderr.write('Logged in using ChatGPT\n'); process.exit(0); }
// 'codex sandbox … -- 명령': 관제실이 켤 때 mxc 샌드박스를 쓸 수 있는지 본다. FAKE_MXC=1 이면 진짜 mxc 처럼 이 PC 연결이 막힌 척한다
if (args[0] === 'sandbox') { console.log(process.env.FAKE_MXC === '1' ? 'CR_NET_EACCES' : 'CR_NET_ECONNREFUSED'); process.exit(0); }
if (args[0] !== 'exec') { process.stderr.write(`fake codex: 모르는 명령 ${args.join(' ')}\n`); process.exit(2); }

const resume = args[1] === 'resume';
const threadId = resume ? args[2] : randomUUID();
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const conf = key => args.map((a, i) => (args[i - 1] === '-c' && a.startsWith(`${key}=`) ? a.slice(key.length + 1) : null)).find(Boolean) || null;
const ext = conf('permissions.cr.extends');   // mxc 에서는 -s 대신 권한 묶음(permissions)으로 샌드박스를 받는다
const sandbox = opt('-s') || conf('sandbox_mode') || (ext ? (ext.includes('read-only') ? 'read-only' : 'workspace-write') : null) || 'read-only';
const cwd = opt('-C') || process.cwd();

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { prompt += d; });
process.stdin.on('end', run);

let n = 0;
const id = () => `item_${n++}`;
const say = text => out({ type: 'item.completed', item: { id: id(), type: 'agent_message', text } });
async function cmd(command, output, code = 0) {
  const item = { id: id(), type: 'command_execution', command: `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "${command}"`, aggregated_output: '', exit_code: null, status: 'in_progress' };
  out({ type: 'item.started', item });
  await sleep(300);
  out({ type: 'item.completed', item: { ...item, aggregated_output: output, exit_code: code, status: code ? 'failed' : 'completed' } });
}
const done = (i = 900, o = 120) => out({ type: 'turn.completed', usage: { input_tokens: i + 5000, cached_input_tokens: 5000, output_tokens: o, reasoning_output_tokens: 10 } });

// 글에 들어 있는 인수인계 쪽지 (첫 '## ' 줄까지). GPT 는 새 대화의 첫 글 앞에 [관제실 안내]가 더 붙어서 맨 앞이 아닐 수 있다.
function noteOf(text) {
  const at = text.search(/\[(인수인계 쪽지|Handoff note)\]/);
  if (at < 0) return '';
  const rest = text.slice(at);
  const m = /^## .*$/m.exec(rest);
  return m ? rest.slice(0, m.index + m[0].length) : rest;
}

async function run() {
  out({ type: 'thread.started', thread_id: threadId });
  out({ type: 'turn.started' });
  await sleep(300);
  const note = noteOf(prompt);

  if (prompt.includes('설정 보기')) {
    const images = args.filter(a => a.startsWith('--image=')).map(a => path.basename(a.slice(8)));   // 같이 넘겨받은 사진
    say(`sandbox=${sandbox} win=${conf('windows.sandbox') || '-'} type=${/cmd \/c type/.test(prompt)} model=${opt('-m') || '-'} effort=${conf('model_reasoning_effort') || '-'} resume=${resume} ignoreUserConfig=${args.includes('--ignore-user-config')} 안내=${/\[(관제실 안내|Control room notice)\]/.test(prompt)} 쪽지=${!!note} images=${images.join(',') || '-'} perm=${conf('default_permissions') || '-'} deny=${conf('permissions.cr.filesystem') || '-'}`);
    return done();
  }
  if (note && prompt.includes('쪽지 보기')) {
    say(`쪽지: ${note}`);
    return done();
  }
  if (/\[(검토 요청|Review request)\]/.test(prompt)) {
    say('일꾼이 고친 파일을 열어 볼게요.');
    await cmd('Get-Content index.html', '<!doctype html>\n<button>로그인</button>\n');
    const fixed = /번째 수정|fix #/.test(prompt);
    const v = fixed
      ? { verdict: 'pass', work: 'index.html 의 버튼에 이름표를 붙였어요.', summary: 'GPT 가 보기에 고칠 점이 없어요.', fix: '' }
      : { verdict: 'fix', work: 'index.html 의 버튼을 고쳤어요.', summary: '버튼에 이름표(aria-label)가 없어요.', fix: 'index.html 의 로그인 버튼에 aria-label="로그인" 을 붙여 줘.' };
    say(`${fixed ? '고친 부분을 확인했어요.' : '이름표가 빠졌어요.'}\n${JSON.stringify(v)}`);
    return done(1500, 200);
  }
  if (/\[(보안 검사 요청|Security check request|시험 요청|Test request)\]/.test(prompt)) {   // 보안 검사관·테스터: 받은 샌드박스를 말하고 통과
    const koread = /cmd \/c type/.test(prompt);   // 읽기 전용에서 한글이 깨지지 않게 읽는 법을 안내받았는지
    say(`sandbox=${sandbox}\n${JSON.stringify({ verdict: 'pass', work: '', summary: `GPT 검사 (sandbox=${sandbox}${koread ? ', type' : ''})`, fix: '' })}`);
    return done(800, 100);
  }
  if (prompt.includes('GPT한도')) {
    out({ type: 'error', message: "You've hit your usage limit. Try again later." });
    out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } });
    return;
  }
  if (prompt.includes('오래')) {
    say('오래 걸리는 일을 시작할게요.');
    out({ type: 'item.started', item: { id: id(), type: 'command_execution', command: 'Start-Sleep 30', aggregated_output: '', exit_code: null, status: 'in_progress' } });
    await hold(30000);
    return done();
  }
  if (prompt.includes('명령으로 쓰기')) {
    say('명령으로 파일을 만들게요.');
    fs.writeFileSync(path.join(cwd, 'gpt-made.txt'), '1');
    await cmd("Set-Content -LiteralPath 'gpt-made.txt' -Value 1 -NoNewline; Get-Content -Raw -LiteralPath 'gpt-made.txt'", '1');
    await hold(30000);
    return done();
  }

  say(note ? '쪽지를 받았어요. 이어서 할게요.' : '작업 폴더를 살펴볼게요.');
  out({ type: 'item.started', item: { id: 'todo', type: 'todo_list', items: [{ text: '파일 살펴보기', completed: false }, { text: 'index.html 고치기', completed: false }] } });
  await cmd('rg --files', 'index.html\n');
  if (sandbox === 'read-only') {
    say('읽기 전용이라 파일은 고치지 않았어요.');
  } else {
    out({ type: 'item.completed', item: { id: id(), type: 'file_change', changes: [{ path: path.join(cwd, 'index.html'), kind: 'update' }], status: 'completed' } });
    say('index.html 의 버튼을 고쳤어요.');
  }
  out({ type: 'item.completed', item: { id: 'todo', type: 'todo_list', items: [{ text: '파일 살펴보기', completed: true }, { text: 'index.html 고치기', completed: sandbox !== 'read-only' }] } });
  done();
}
