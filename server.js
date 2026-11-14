'use strict';
// 클로드 관제실 서버 — Node 기본 모듈만 써서 따로 설치할 것이 없다.
// 화면(index.html)을 보내 주고, 에이전트마다 claude CLI 프로세스를 하나씩 붙여
// stream-json 으로 일을 주고받는다. 화면과는 SSE(/api/events)로 실시간 연결한다.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile, execFileSync } = require('node:child_process');

// ── 실행 옵션: node server.js [--port 7707] [--no-open] [--data 폴더] [--claude 경로] [--codex 경로] ──
const argv = process.argv.slice(2);
const argValue = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const PORT = Number(argValue('port')) || 7707;
const HOST = '127.0.0.1';
const ROOT = __dirname;
// 저장 폴더(설정·기록): 실행 옵션 --data > 앱 폴더의 config.json 에 고른 폴더 > 앱 폴더의 data
const CONFIG_FILE = path.join(ROOT, 'config.json');
const DATA_ARG = argValue('data');
const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
let DATA_DIR = path.resolve(DATA_ARG || readJson(CONFIG_FILE)?.dataDir || DEFAULT_DATA_DIR);
const CLAUDE_ARG = argValue('claude');
const CODEX_ARG = argValue('codex');
const OPEN_WINDOW = !argv.includes('--no-open');
const WORKDIR = path.join(ROOT, 'workspace');   // 처음 켤 때의 기본 작업 폴더 (전부터 쓰던 설치는 저장해 둔 '작업실'을 그대로 쓴다)

const TOKEN = crypto.randomBytes(16).toString('hex');   // 다른 웹사이트가 이 서버를 조종하지 못하게 화면에만 심어 두는 열쇠
const MIN_AGENTS = 1;
const MAX_AGENTS = 8;
const LOG_KEEP = 300;                     // 에이전트마다 기억하는 로그 줄 수
const LOG_SAVE = 150;                     // 그중 파일에 남기는 줄 수
const HISTORY_KEEP = 300;
const REPORT_KEEP = 60;                   // 감독관 보고 카드 수
const REPORT_LIVE = ['queued', 'reviewing', 'fixing'];   // 아직 끝나지 않은 보고 (검토 대기·검토 중·일꾼이 고치는 중)
const IDLE_CLOSE_MS = 10 * 60 * 1000;     // 10분 동안 일이 없으면 claude 프로세스를 닫아 메모리를 아낀다 (다음 일 때 이어서 연다)
const COLORS = ['#D97757', '#6AA9FF', '#5FD08A', '#B58CFF', '#F2C14E', '#FF7AB6', '#4FD6D6', '#C8CDD6'];
const MODES = ['acceptEdits', 'manual', 'auto', 'plan'];   // 권한 확인을 통째로 건너뛰는 모드는 일부러 넣지 않았다
const MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const ENGINES = ['claude', 'codex'];   // 에이전트가 쓰는 AI: Claude Code, 또는 GPT(OpenAI 공식 Codex CLI)
const GPT_MODEL = /^[\w.:-]{0,64}$/;
const AUTH_ERROR = /authenticat|not logged in|\/login|oauth|api key|401/i;
const LIMIT_ERROR = /usage limit|limit reached|hit your (?:usage )?limit|rate.?limit|quota|exceeded your|429/i;   // Claude 사용량 한도
const LIMIT_GUESS_MS = 60 * 60 * 1000;   // 한도가 풀리는 시각을 모르면 1시간 뒤에 Claude 를 다시 시도한다
const TOOL_KO = {
  Bash: '명령', PowerShell: '명령', Read: '읽기', Write: '새 파일', Edit: '수정', MultiEdit: '수정',
  NotebookEdit: '노트 수정', Glob: '파일 찾기', Grep: '내용 찾기', WebFetch: '웹 읽기', WebSearch: '웹 검색',
  TodoWrite: '할 일', Task: '도우미', Agent: '도우미', LS: '폴더 보기',
};
const STATUS_KO = { done: '완료', error: '오류', stopped: '중지됨' };

const DEFAULT_SETTINGS = {
  lang: '',            // 'ko' | 'en' — 비어 있으면 처음 켤 때 PC 언어로 정한다
  setupDone: false,    // 처음 켤 때 언어·저장 위치를 골랐는지
  claudePath: '',
  defaultCwd: WORKDIR,
  defaultEngine: 'claude',
  defaultModel: '',
  defaultGptModel: '',   // GPT(Codex) 모델. 비우면 Codex 기본 모델
  defaultEffort: '',
  defaultFast: false,   // 빠른 모드(Opus 전용). 구독 요금제에 들어 있지 않고 유료 사용량 크레딧에서 돈이 나가서 기본은 끔
  defaultPermission: 'acceptEdits',
  sound: true,
  hoverMenu: true,
  // 감독관: 일꾼이 끝낸 일(파일을 고쳤거나 명령을 돌린 일)을 읽기 도구만으로 검토하고, 고칠 점은 그 일꾼에게 다시 시킨다
  supervisor: { enabled: true, engine: 'claude', model: 'sonnet', gptModel: '', maxRounds: 2 },   // engine 'codex' = GPT 가 검사
  // 대체 AI: Claude 사용량이 바닥나면 claude-code-router(CCR) 게이트웨이를 거쳐 다른 AI 가 이어서 한다
  fallbackEnabled: false,
  fallbackUrl: 'http://127.0.0.1:3456',
  fallbackKey: '',
  fallbackModels: [],   // 대체 AI 를 쓸 순서 (CCR 모델 이름). 앞의 것이 실패하면 다음 것으로 넘어간다. 비어 있으면 CCR 기본 모델
};
const MODEL_COOLDOWN_MS = 15 * 60 * 1000;   // 실패한 대체 AI 모델은 15분 동안 건너뛴다
const modelCooldown = new Map();              // 모델 이름 → 다시 써 볼 수 있는 시각

let settings = { ...DEFAULT_SETTINGS };
let agents = [];
let supervisor = null;   // 감독관 (loadState 에서 만든다)
let history = [];
let reports = [];   // 감독관 보고: 검토한 일 하나에 카드 하나. 고치게 했다가 다시 보는 동안에도 같은 카드를 이어서 고친다
let auth ={ checked: false, checking: false, loggedIn: null, method: null };
let claude = { path: null, version: null };
let codex = { path: null, version: null, loggedIn: null, method: null, models: [] };   // GPT 를 돌리는 공식 Codex CLI
let rateStatus = 'allowed';
let limit = { hit: false, until: 0, at: 0 };               // Claude 사용량 한도 (계정 전체라서 에이전트끼리 같이 쓴다)
let ccr = { checked: false, ok: false, error: '', models: [] };   // CCR 게이트웨이 상태
let seq = 0;

const newId = () => Date.now().toString(36) + (++seq).toString(36) + crypto.randomBytes(2).toString('hex');
const clock = () => new Date().toTimeString().slice(0, 8);
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const firstLine = s => String(s || '').split('\n')[0];
const toolKo = name => (TOOL_KO[name] ? t(TOOL_KO[name]) : name || t('도구'));
const statusKo = s => (STATUS_KO[s] ? t(STATUS_KO[s]) : s);
const cleanText = t => String(t || '').replace(/\r\n?/g, '\n').trim().slice(0, 20000);
const stripAnsi = s => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');   // 명령 출력에 섞인 글자색 코드 지우기

// ── 언어: 한국어 글을 그대로 열쇠로 쓰고, 다른 언어는 locales/<언어>.json 사전에서 찾는다 (사전에 없으면 한국어 그대로) ──
const LANGS = ['ko', 'en'];
const DICTS = { en: readJson(path.join(ROOT, 'locales', 'en.json')) || {} };
const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);
const t = (ko, vars) => fill(DICTS[settings.lang]?.[ko] ?? ko, vars);   // {name} 자리에 값을 넣는다. 한국어 조사는 값으로 따로 넘긴다
const osLang = () => (/^ko/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'ko' : 'en');

// ───────────────────────── 저장 ─────────────────────────

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, data) {
  const text = JSON.stringify(data);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, text);   // 백신 등이 파일을 잡고 있어 이름 바꾸기가 막히면 그냥 덮어쓴다
  }
}

function nextName() {
  for (let i = 1; ; i++) {
    const name = t('클로드 {n}', { n: i });
    if (!agents.some(a => a.name === name)) return name;
  }
}

function nextColor() {
  return COLORS.find(c => !agents.some(a => a.color.toLowerCase() === c.toLowerCase())) || COLORS[agents.length % COLORS.length];
}

function makeAgent(saved = {}, log = []) {
  return {
    id: saved.id || newId(),
    name: saved.name || nextName(),
    color: saved.color || nextColor(),
    role: saved.role || '',
    cwd: saved.cwd || settings.defaultCwd,
    engine: ENGINES.includes(saved.engine) ? saved.engine : (ENGINES.includes(settings.defaultEngine) ? settings.defaultEngine : 'claude'),
    gptModel: typeof saved.gptModel === 'string' && GPT_MODEL.test(saved.gptModel) ? saved.gptModel : (settings.defaultGptModel || ''),
    codexThread: saved.codexThread || null,   // GPT 쪽 대화 (다음 일은 이 대화를 이어서 한다)
    lastAi: saved.lastAi || null,             // 마지막 일을 한 AI (바뀌면 인수인계 쪽지를 건넨다)
    model: MODELS.includes(saved.model) ? saved.model : settings.defaultModel,
    effort: EFFORTS.includes(saved.effort) ? saved.effort : settings.defaultEffort,
    fast: typeof saved.fast === 'boolean' ? saved.fast : !!settings.defaultFast,
    permissionMode: MODES.includes(saved.permissionMode) ? saved.permissionMode : settings.defaultPermission,
    sessionId: saved.sessionId || null,
    mode: saved.mode === 'fallback' ? 'fallback' : 'claude',   // 지금 누구에게 일을 시키는지
    autoMode: !!saved.autoMode,                                // 한도 때문에 저절로 대체 AI 로 바뀐 상태인지
    fbSessionId: saved.fbSessionId || null,                    // 대체 AI 쪽 대화 (Claude 대화와 섞지 않는다)
    fbModel: typeof saved.fbModel === 'string' ? saved.fbModel : null,   // 지금 쓰는 대체 AI 모델
    last: saved.last || null,
    stats: { runs: 0, tokensIn: 0, tokensOut: 0, ...(saved.stats || {}) },
    log: Array.isArray(log) ? log.slice(-LOG_KEEP) : [],
    // 아래는 실행 중에만 쓰고 저장하지 않는 값
    proc: null,
    status: 'idle',
    activity: '',
    runtimeModel: null,
    current: null,
    queue: [],
    pending: new Map(),
    tools: new Map(),
    dirty: false,
    removed: false,
    delta: '',
    deltaTimer: null,
    stopTimer: null,
    idleTimer: null,
  };
}

function loadState() {
  const saved = readJson(path.join(DATA_DIR, 'state.json')) || {};
  const logs = readJson(path.join(DATA_DIR, 'logs.json')) || {};
  settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
  // 전부터 쓰던 기록이면 한국어로 설정을 마친 것으로 본다. 처음 켜면 PC 언어로 시작하고, 첫 화면에서 언어·저장 위치를 고른다
  if (saved.settings && saved.settings.setupDone === undefined) Object.assign(settings, { setupDone: true, lang: saved.settings.lang || 'ko' });
  if (!LANGS.includes(settings.lang)) settings.lang = osLang();
  if (!Array.isArray(settings.fallbackModels)) settings.fallbackModels = [];
  if (settings.fallbackModel) {   // 예전 '모델 하나' 설정을 순서 목록으로 옮긴다
    if (!settings.fallbackModels.includes(settings.fallbackModel)) settings.fallbackModels.unshift(settings.fallbackModel);
    delete settings.fallbackModel;
  }
  if (!MODES.includes(settings.defaultPermission)) settings.defaultPermission = DEFAULT_SETTINGS.defaultPermission;
  settings.supervisor = { ...DEFAULT_SETTINGS.supervisor, ...(saved.settings?.supervisor || {}) };
  history = Array.isArray(saved.history) ? saved.history.slice(0, HISTORY_KEEP) : [];
  reports = Array.isArray(saved.reports) ? saved.reports.slice(0, REPORT_KEEP) : [];
  for (const r of reports) {   // 앱을 끄면 기다리던 검토·고치기도 사라진다
    if (REPORT_LIVE.includes(r.state)) Object.assign(r, { state: 'stopped', note: t('앱을 다시 켜서 검토가 끊겼어요') });
  }
  agents = [];
  const list = Array.isArray(saved.agents) ? saved.agents.slice(0, MAX_AGENTS) : [];
  for (const s of list) agents.push(makeAgent(s, logs[s.id]));
  const want = list.length ? MIN_AGENTS : 4;   // 처음 켤 때는 4명으로 시작
  while (agents.length < want) agents.push(makeAgent());
  // 감독관은 일꾼 수(1~8명)에 들어가지 않는 따로 된 에이전트다. 실행·기록 방식은 일꾼과 같은 코드를 쓴다.
  supervisor = makeAgent({ ...(saved.supervisor || {}), id: 'supervisor', name: t('감독관'), color: '#FFD23F', cwd: settings.defaultCwd }, logs.supervisor);
  supervisor.isSupervisor = true;
  supervisor.permissionMode = 'dontAsk';
  supervisor.fast = false;
  supervisor.model = settings.supervisor.model;
}

const allAgents = () => (supervisor ? [...agents, supervisor] : agents);

let saveTimer = null;
function save() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 500);
}

function saveNow(dir = DATA_DIR) {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'state.json'), {
      settings,
      agents: agents.map(a => ({
        id: a.id, name: a.name, color: a.color, role: a.role, cwd: a.cwd, model: a.model, effort: a.effort, fast: a.fast,
        engine: a.engine, gptModel: a.gptModel, codexThread: a.codexThread, lastAi: a.lastAi,
        permissionMode: a.permissionMode, sessionId: a.sessionId, last: a.last, stats: a.stats,
        mode: a.mode, autoMode: a.autoMode, fbSessionId: a.fbSessionId, fbModel: a.fbModel,
      })),
      history,
      reports,
      supervisor: supervisor && { stats: supervisor.stats, last: supervisor.last, mode: supervisor.mode, autoMode: supervisor.autoMode, fbModel: supervisor.fbModel },
    });
    writeJson(path.join(dir, 'logs.json'), Object.fromEntries(allAgents().map(a => [a.id, a.log.slice(-LOG_SAVE)])));
    return true;
  } catch (e) {
    console.error(t('저장하지 못했어요:'), e.message);
    return false;
  }
}

// ───────────────────────── 화면으로 보내기 (SSE) ─────────────────────────

const clients = new Set();

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

function pub(a) {
  return {
    id: a.id, name: a.name, color: a.color, role: a.role, cwd: a.cwd, isSupervisor: !!a.isSupervisor,
    model: a.model, effort: a.effort, fast: !!a.fast, fastState: a.fastState || null, permissionMode: a.permissionMode,
    engine: a.engine, gptModel: a.gptModel, lastAi: a.lastAi,
    sessionId: a.sessionId, runtimeModel: a.runtimeModel, stats: a.stats, mode: a.mode, autoMode: a.autoMode, fbModel: a.fbModel,
    status: a.status, last: a.last, activity: a.activity, running: !!a.proc,
    current: a.current && {
      prompt: a.current.prompt, startedAt: a.current.startedAt, stopping: !!a.current.stopping,
      reviewing: a.current.review?.workerName || null,   // 감독관이 지금 검토하는 일꾼
    },
    queue: a.queue.map(q => ({ id: q.id, text: q.text })),
    pending: [...a.pending.values()].map(p => ({
      requestId: p.requestId, tool: p.tool, summary: p.summary, desc: p.desc, canAlways: p.suggestions.length > 0,
    })),
  };
}

function sendAgent(a) {
  scheduleSweep();
  if (a.removed) return;
  broadcast({ type: a.isSupervisor ? 'supervisor' : 'agent', agent: pub(a) });
}

function sendAgents() {
  scheduleSweep();
  broadcast({ type: 'agents', agents: agents.map(pub) });
}

const appInfo = () => ({ url: `http://${HOST}:${PORT}/`, dataDir: DATA_DIR, dataFixed: !!DATA_ARG, defaultDataDir: DEFAULT_DATA_DIR });

function snapshot() {
  return {
    type: 'snapshot',
    settings,
    agents: agents.map(pub),
    supervisor: pub(supervisor),
    logs: Object.fromEntries(allAgents().map(a => [a.id, a.log])),
    history,
    reports,
    auth,
    claude,
    codex,
    limit,
    ccr,
    limits: { min: MIN_AGENTS, max: MAX_AGENTS },
    colors: COLORS,
    app: appInfo(),
  };
}

function setStatus(a, status) {
  a.status = status;
  sendAgent(a);
}

function setActivity(a, text) {
  if (text && text !== a.activity) {
    a.activity = text;
    sendAgent(a);
  }
}

function addLog(a, entry) {
  entry.t = Date.now();
  a.log.push(entry);
  if (a.log.length > LOG_KEEP) a.log.splice(0, a.log.length - LOG_KEEP);
  if (!a.removed) broadcast({ type: 'log', id: a.id, entry });
  save();
}

// 글자가 쏟아질 때 화면에 너무 자주 보내지 않도록 조금씩 모아서 보낸다
function pushDelta(a, text) {
  a.delta += text;
  if (!a.deltaTimer) a.deltaTimer = setTimeout(() => flushDelta(a), 70);
}

function flushDelta(a) {
  clearTimeout(a.deltaTimer);
  a.deltaTimer = null;
  if (!a.delta) return;
  if (!a.removed) broadcast({ type: 'delta', id: a.id, text: a.delta });
  a.delta = '';
}

// ───────────────────────── claude CLI 찾기·로그인 ─────────────────────────

// 클로드 코드 세션 안에서 서버를 켰을 때 그 세션 전용 값(프록시 주소 등)을 에이전트에게 물려주지 않는다
function childEnv() {
  const env = { ...process.env };
  if (env.CLAUDECODE) {
    for (const k of Object.keys(env)) {
      if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || /^ANTHROPIC_(API_)?BASE_URL$/.test(k) || /^CLAUDE_(CODE|AGENT_SDK|PREVIEW)_/.test(k)) delete env[k];
    }
  }
  return env;
}

function findClaude() {
  const wanted = CLAUDE_ARG || settings.claudePath;
  if (wanted) return fs.existsSync(wanted) ? path.resolve(wanted) : null;
  const found = [];
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(finder, ['claude'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    found.push(...out.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  } catch { /* PATH 에 없음 */ }
  found.push(path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
  if (process.platform !== 'win32') return found.find(f => fs.existsSync(f)) || null;
  const exe = found.find(f => /\.exe$/i.test(f) && fs.existsSync(f));
  if (exe) return exe;
  // npm 으로 깔린 claude.cmd 는 셸 없이 돌릴 수 없어서, 안쪽의 cli.js 를 node 로 직접 돌린다
  for (const f of found) {
    const js = path.join(path.dirname(f), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (/\.cmd$/i.test(f) && fs.existsSync(js)) return js;
  }
  return null;
}

const command = (file, args) => (/\.[cm]?js$/i.test(file) ? [process.execPath, [file, ...args]] : [file, args]);

function detectClaude() {
  claude = { path: findClaude(), version: null };
  broadcast({ type: 'claude', claude });
  if (!claude.path) {
    auth = { checked: true, checking: false, loggedIn: null, method: null };
    broadcast({ type: 'auth', auth });
    return;
  }
  const found = claude.path;
  const [cmd, args] = command(found, ['--version']);
  execFile(cmd, args, { env: childEnv(), windowsHide: true, timeout: 30000 }, (err, out) => {
    if (claude.path !== found) return;
    claude.version = String(out || '').trim().split(/\r?\n/)[0] || null;
    broadcast({ type: 'claude', claude });
  });
  checkAuth();
}

function checkAuth() {
  if (!claude.path || auth.checking) return;
  auth = { ...auth, checking: true };
  broadcast({ type: 'auth', auth });
  const [cmd, args] = command(claude.path, ['auth', 'status']);
  // 로그인이 안 돼 있으면 종료 코드가 1이지만 JSON 은 똑같이 나온다
  execFile(cmd, args, { env: childEnv(), windowsHide: true, timeout: 30000 }, (err, out) => {
    let info = null;
    try { info = JSON.parse(out); } catch { /* 형식이 다르면 모름으로 둔다 */ }
    auth = { checked: true, checking: false, loggedIn: info ? !!info.loggedIn : null, method: info?.authMethod || null };
    broadcast({ type: 'auth', auth });
    if (auth.loggedIn) stopLoginWatch();
  });
}

let loginWatch = null;
function stopLoginWatch() {
  clearInterval(loginWatch);
  loginWatch = null;
}

// 새 콘솔 창에 로그인.bat 을 띄운다. 로그인은 사용자가 그 창과 브라우저에서 직접 한다.
function openLogin() {
  if (!claude.path) return t('먼저 claude 위치를 찾아야 해요. 설정 창에서 확인해 주세요.');
  if (process.platform !== 'win32') return t('터미널에서 claude auth login 을 실행해 주세요.');
  const [cmd, args] = command(claude.path, []);
  // claude 경로는 환경 변수로 넘긴다. start 줄에 따옴표 친 인자가 더 붙으면 cmd 가 따옴표를 엉뚱하게 벗겨 낸다.
  const env = { ...childEnv(), LOGIN_CLAUDE: cmd, LOGIN_CLAUDE_ARG: args.map(a => `"${a}"`).join(' ') };
  spawn('cmd.exe', ['/d', '/c', `start "Claude 로그인" "${path.join(ROOT, '로그인.bat')}"`], {
    env, windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();
  stopLoginWatch();
  const until = Date.now() + 3 * 60 * 1000;
  loginWatch = setInterval(() => (Date.now() > until ? stopLoginWatch() : checkAuth()), 4000);
  return null;
}

// ───────────────────────── GPT (OpenAI 공식 Codex CLI) ─────────────────────────
// GPT 에이전트는 Codex CLI 로 일한다. 일 하나마다 `codex exec --json` 을 하나 띄우고, 다음 일은 같은 대화를 resume 한다.
// --ignore-user-config 로 ~/.codex/config.toml 을 읽지 않는다: CCR 같은 다른 도구가 그 파일을 바꿔 놔도
// 사용자의 ChatGPT 로그인(~/.codex/auth.json)으로 OpenAI 에 바로 간다. 허락을 물을 수 없어서 대신 Codex 샌드박스로 막는다.

function findCodex() {
  if (CODEX_ARG) return fs.existsSync(CODEX_ARG) ? path.resolve(CODEX_ARG) : null;
  if (process.platform === 'win32') {
    // Codex 앱에 들어 있는 CLI 를 먼저 쓴다. 윈도 샌드박스 도우미(codex-windows-sandbox-setup.exe)가 바로 옆에 있어야
    // 작업 폴더에 쓸 수 있는데, 따로 깐 standalone CLI 에는 이 도우미가 없다. 앱이 업데이트되면 폴더 이름이 바뀌니 가장 새것을 고른다.
    const appBin = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    try {
      const dirs = fs.readdirSync(appBin, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(appBin, d.name))
        .filter(d => fs.existsSync(path.join(d, 'codex.exe')) && fs.existsSync(path.join(d, 'codex-windows-sandbox-setup.exe')))
        .sort((x, y) => fs.statSync(path.join(y, 'codex.exe')).mtimeMs - fs.statSync(path.join(x, 'codex.exe')).mtimeMs);
      if (dirs.length) return path.join(dirs[0], 'codex.exe');
    } catch { /* Codex 앱이 없음 */ }
  }
  const found = [];
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(finder, ['codex'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    found.push(...out.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  } catch { /* PATH 에 없음 */ }
  if (process.platform !== 'win32') return found.find(f => fs.existsSync(f)) || null;
  found.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));   // Codex 앱이 까는 곳
  const exe = found.find(f => /\.exe$/i.test(f) && fs.existsSync(f));
  if (exe) return exe;
  // npm 으로 깐 codex.cmd 는 셸 없이 돌릴 수 없어서, 안쪽의 codex.js 를 node 로 직접 돌린다
  for (const f of found) {
    const js = path.join(path.dirname(f), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (/\.cmd$/i.test(f) && fs.existsSync(js)) return js;
  }
  return null;
}

// Codex 가 이 계정으로 받아 둔 모델 목록 (화면의 GPT 모델 칸). 못 읽으면 'GPT 기본'만 고를 수 있다.
function codexModels() {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
    return (cache.models || [])
      .filter(m => m && m.visibility === 'list' && typeof m.slug === 'string' && GPT_MODEL.test(m.slug))
      .map(m => ({ id: m.slug, name: String(m.display_name || m.slug) }));
  } catch { return []; }
}

function detectCodex() {
  codex = { path: findCodex(), version: null, loggedIn: null, method: null, models: codexModels() };
  broadcast({ type: 'codex', codex });
  if (!codex.path) return;
  const found = codex.path;
  const [cmd, args] = command(found, ['--version']);
  execFile(cmd, args, { env: childEnv(), windowsHide: true, timeout: 30000 }, (err, out) => {
    if (codex.path !== found) return;
    codex.version = String(out || '').trim().split(/\r?\n/)[0] || null;
    broadcast({ type: 'codex', codex });
  });
  // 로그인 상태는 stderr 로 나온다 ("Logged in using ChatGPT" / "Not logged in")
  const [cmd2, args2] = command(found, ['login', 'status']);
  execFile(cmd2, args2, { env: childEnv(), windowsHide: true, timeout: 30000 }, (err, out, errOut) => {
    if (codex.path !== found) return;
    const text = `${out}\n${errOut}`;
    codex.loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
    codex.method = !codex.loggedIn ? null : /chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? t('API 키') : null;
    broadcast({ type: 'codex', codex });
  });
}

const AI_KO = { claude: 'Claude', fallback: '대체 AI', gpt: 'GPT(Codex)' };
const aiKo = k => t(AI_KO[k]);
const aiOf = (a, useCodex) => (useCodex ? 'gpt' : a.mode === 'fallback' ? 'fallback' : 'claude');

// 에이전트의 AI 가 바뀌면 새 AI 에게 먼저 건네는 쪽지. 관제실이 이미 가진 기록(시킨 일·마지막 말·고친 파일)으로 만든다.
// takeover: 'running' = 하던 일을 중간에 넘겨받음, 'failed' = 막힌 일을 넘겨받음 (⇄ 넘기기 버튼)
function handoffNote(a, from, to, takeover) {
  const log = a.log.slice(-80);
  const user = [...log].reverse().find(e => e.k === 'user');
  // 결과와 마지막 말은 그 일을 받은 뒤의 기록에서만 찾는다 (한도로 끊긴 일엔 끝난 기록이 없어 앞 일의 '완료'가 붙었다)
  const after = user ? log.slice(log.indexOf(user)) : log;
  const last = k => [...after].reverse().find(e => e.k === k);
  const said = last('text');
  const done = last('done');
  if (!user && !said) return '';
  const files = [...new Set(log.filter(e => e.k === 'tool' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(e.name)).map(e => e.summary).filter(Boolean))].slice(-8);
  // 명령(Set-Content 등)으로 바꾼 파일은 위 목록에 안 잡힌다 (GPT 는 윈도에서 파일을 주로 명령으로 쓴다). 그 명령을 대상이 보이게 잘라서 넣는다
  const cmds = log.filter(e => e.k === 'tool' && /^(Bash|PowerShell)$/.test(e.name) && WRITE_CMD.test(e.summary || '')).slice(-3)
    .map(e => { const c = e.summary.replace(/\s+/g, ' '); const i = Math.max(0, c.search(WRITE_CMD) - 40); return `${i ? '…' : ''}${c.slice(i, i + 160)}`; });
  const ai = { from: aiKo(from), to: aiKo(to) };
  const head = takeover === 'running'
    ? t('[인수인계 쪽지] 다른 AI({from})가 하던 일을 중간에 {to}가 넘겨받았어요. 작업 폴더를 직접 살펴서 이미 된 부분은 다시 하지 말고, 남은 부분을 이어서 끝내 주세요.', ai)
    : takeover === 'failed'
      ? t('[인수인계 쪽지] 다른 AI({from})가 하다가 막힌 일을 {to}가 넘겨받았어요. 작업 폴더를 직접 살펴서 이미 된 부분은 다시 하지 말고, 무엇이 문제였는지 참고해서 끝내 주세요.', ai)
      : t('[인수인계 쪽지] 이 작업 폴더에서 다른 AI({from})가 하던 일을 지금부터 {to}가 이어받아요. 참고하고, 아래 새 요청을 해 주세요.', ai);
  const lines = [
    head,
    user && t('- 마지막으로 받은 일: {v}', { v: firstLine(user.text).slice(0, 200) }),
    done && t('- 그 일의 결과: {v}', { v: `${statusKo(done.status)}${done.text ? ` — ${firstLine(done.text).slice(0, 150)}` : ''}` }),
    said && t('- 마지막으로 남긴 말: {v}', { v: said.text.replace(/\s+/g, ' ').slice(0, 400) }),
    files.length && t('- 최근에 고친 파일: {v}', { v: files.join(', ') }),
    cmds.length && t('- 파일을 바꾼 명령: {v}', { v: cmds.join(' / ') }),
  ].filter(Boolean);
  return `${lines.join('\n')}\n\n## ${takeover ? t('넘겨받은 일') : t('새 요청')}\n`;
}

// 허락을 물을 수 없으니 권한 모드를 Codex 샌드박스로 옮긴다: 계획·모두 물어보기 → 읽기만, 나머지 → 작업 폴더 안에서만 고치기
const codexSandbox = a => (a.isSupervisor || a.permissionMode === 'plan' || a.permissionMode === 'manual' ? 'read-only' : 'workspace-write');

function codexArgs(a, resume) {
  const opts = ['--json', '--ignore-user-config', '--skip-git-repo-check'];
  // 윈도에서는 unelevated 샌드박스를 쓴다. 설정이 없으면 작업 폴더에도 못 쓰고, elevated 는 PowerShell 이 제한 모드라
  // 한글 출력이 깨지고 명령이 C:\ 에서 시작된다. unelevated 도 작업 폴더 밖 쓰기는 막는다 (2026-10-31 직접 확인).
  if (process.platform === 'win32') opts.push('-c', 'windows.sandbox=unelevated');
  if (a.gptModel) opts.push('-m', a.gptModel);
  if (a.effort) opts.push('-c', `model_reasoning_effort=${a.effort}`);
  return resume
    ? ['exec', 'resume', a.codexThread, ...opts, '-c', `sandbox_mode=${codexSandbox(a)}`, '-']
    : ['exec', ...opts, '-s', codexSandbox(a), '-C', a.cwd, '-'];
}

// 윈도에서 Codex 는 명령을 powershell.exe -Command "..." 로 감싸서 돌리니, 화면에는 안쪽 명령만 보여 준다
const cleanCmd = c => String(Array.isArray(c) ? c.join(' ') : c || '')
  .replace(/^"?[^"\s]*(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+/i, '')
  .replace(/^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+/, '')
  .replace(/^"([\s\S]*)"$/, '$1');

// 파일을 만들거나 바꾸는 명령 (읽기만 하는 명령은 감독관 검토를 부르지 않게 따로 고른다)
const WRITE_CMD = /\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|Rename-Item|Expand-Archive|mkdir|npm\s+(?:i|install|init)|pip\s+install|git\s+(?:add|commit|apply|checkout|reset|init))\b/i;

// GPT 오류의 종류(한도·로그인)는 원래 오류 글로 판단한다 (화면에 보여 주는 글은 언어에 따라 바뀐다)
const codexErrorKind = msg => (/usage limit|rate.?limit|429|quota/i.test(msg) ? 'limit' : /not logged in|unauthori[sz]ed|401|log ?in/i.test(msg) ? 'login' : null);

function codexError(msg) {
  const text = stripAnsi(String(msg || '')).trim();
  const kind = codexErrorKind(text);
  if (kind === 'limit') return `${t('GPT(Codex) 사용량 한도에 걸렸어요. 한도가 풀리면 다시 시켜 주세요.')}\n${text}`;
  if (kind === 'login') return `${t('Codex 로그인이 필요해요. Codex 앱이나 명령창(codex login)에서 ChatGPT 로 로그인해 주세요.')}\n${text}`;
  return text || t('GPT(Codex)가 알 수 없는 오류로 멈췄어요');
}

// 일 하나를 codex exec 하나로 돌린다 (글은 stdin 으로 넘긴다: 길거나 따옴표가 섞여도 안전하게)
function startCodexTurn(a, text) {
  const resume = !!a.codexThread && !a.isSupervisor;
  const [cmd, args] = command(codex.path, codexArgs(a, resume));
  const proc = spawn(cmd, args, { cwd: a.cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  proc.buf = '';
  proc.errTail = '';
  proc.ended = false;
  proc.mode = 'codex';
  a.proc = proc;
  a.current.proc = proc;
  proc.stdin.on('error', () => { /* 먼저 꺼지면 생기는 EPIPE 는 무시 */ });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', chunk => readLines(a, proc, chunk));
  proc.stderr.on('data', chunk => { proc.errTail = (proc.errTail + chunk).slice(-4000); });
  proc.on('error', err => codexEnded(a, proc, null, err));
  proc.on('close', code => codexEnded(a, proc, code, null));
  proc.stdin.end(text);
  console.log(`[${clock()}] ${a.name}: ${t('GPT(Codex) 켬')} (${codexSandbox(a)}${a.gptModel ? `, ${a.gptModel}` : ''}${resume ? `, ${t('이어서')}` : ''})`);
}

function logTodo(a, cur, items) {
  const summary = items.map(t => `${t.completed ? '☑' : '☐'} ${t.text || ''}`).join('\n');
  if (summary === cur.lastTodo) return;
  cur.lastTodo = summary;
  addLog(a, { k: 'tool', name: 'TodoWrite', summary });
}

// codex exec --json 이벤트 → 관제실 기록. 모양: thread.started · turn.started · item.started/updated/completed · turn.completed/failed · error
function onCodexEvent(a, proc, ev) {
  const cur = a.current && a.current.proc === proc ? a.current : null;
  if (!cur) return;
  const item = ev.item && typeof ev.item === 'object' ? ev.item : {};
  switch (ev.type) {
    case 'thread.started':
      if (!a.isSupervisor && ev.thread_id && a.codexThread !== ev.thread_id) { a.codexThread = ev.thread_id; save(); }
      break;
    case 'turn.started':
      setActivity(a, t('생각하는 중'));
      break;
    case 'item.started':
    case 'item.updated':
      if (item.type === 'command_execution' && ev.type === 'item.started') {
        const c = cleanCmd(item.command);
        addLog(a, { k: 'tool', name: 'Bash', summary: c.slice(0, 1500) });
        setActivity(a, t('명령 {cmd}', { cmd: firstLine(c).slice(0, 60) }));
      } else if (item.type === 'reasoning') setActivity(a, t('생각하는 중'));
      else if (item.type === 'todo_list' && Array.isArray(item.items)) logTodo(a, cur, item.items);
      break;
    case 'item.completed':
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
        cur.lastText = item.text;
        const text = a.isSupervisor ? stripVerdict(item.text) : item.text.trim();
        if (text) addLog(a, { k: 'text', text });
      } else if (item.type === 'command_execution') {
        const failed = item.exit_code != null && item.exit_code !== 0;
        const out = summarizeResult('Bash', item.aggregated_output || '', failed);
        if (out) addLog(a, { k: 'out', text: out, err: failed });
        // GPT 가 파일 편집 대신 명령(Set-Content 등)으로 파일을 바꿨으면 그것도 감독관 검토 자료에 넣는다
        const c = cleanCmd(item.command);
        if (!failed && !a.isSupervisor && WRITE_CMD.test(c)) trackWork(a, cur, { name: 'Bash', input: { command: c } });
      } else if (item.type === 'file_change' && Array.isArray(item.changes)) {
        // GPT 는 파일을 읽을 때도 명령을 쓰니, 감독관 검토 자료로는 실제로 고친 파일만 모은다
        for (const c of item.changes) {
          const name = c.kind === 'add' ? 'Write' : 'Edit';
          addLog(a, { k: 'tool', name, summary: shortPath(c.path) });
          if (!a.isSupervisor) trackWork(a, cur, { name, input: { file_path: c.path } });
        }
        setActivity(a, t('파일 고치는 중'));
      } else if (item.type === 'web_search') {
        addLog(a, { k: 'tool', name: 'WebSearch', summary: String(item.query || '') });
      } else if (item.type === 'mcp_tool_call') {
        addLog(a, { k: 'tool', name: `${item.server || 'mcp'}/${item.tool || ''}`, summary: '' });
      } else if (item.type === 'todo_list' && Array.isArray(item.items)) logTodo(a, cur, item.items);
      else if (item.type === 'error' && item.message) addLog(a, { k: 'sys', text: t('알림: {msg}', { msg: item.message }) });
      break;
    case 'turn.completed': {
      const u = ev.usage || {};
      cur.codexDone = true;
      endTurn(a, {
        status: cur.stopping ? 'stopped' : 'done', text: cur.lastText || '',
        ev: { usage: { input_tokens: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)), output_tokens: u.output_tokens || 0 } },
      });
      setTimeout(() => forceKill(proc), 5000);   // 보통 바로 스스로 끝난다 (끝나면 codexEnded 가 다음 일을 꺼낸다)
      break;
    }
    case 'turn.failed':
      cur.codexDone = true;
      endTurn(a, { status: cur.stopping ? 'stopped' : 'error', text: codexError(ev.error?.message || cur.errText) });
      setTimeout(() => forceKill(proc), 5000);
      break;
    case 'error':
      cur.errText = ev.message;   // 보통 turn.failed 가 뒤따른다. 없이 끝나면 codexEnded 가 이 글로 오류를 낸다
      break;
    default:
      break;
  }
}

function codexEnded(a, proc, code, err) {
  if (proc.ended) return;
  proc.ended = true;
  if (a.proc === proc) a.proc = null;
  const cur = a.current;
  if (cur && cur.proc === proc && !cur.codexDone) {   // turn.completed·turn.failed 없이 끝났다
    const tail = stripAnsi(proc.errTail).trim();
    if (err) endTurn(a, { status: 'error', text: t('codex 를 실행하지 못했어요: {why}', { why: err.message }) });
    else if (cur.stopping) endTurn(a, { status: 'stopped' });
    else if (!cur.retried && a.codexThread && !a.isSupervisor && /no (?:rollout|session|conversation|thread)|not found/i.test(tail)) {
      // 이어 하려던 GPT 대화 파일이 없어졌으면 새 대화로 한 번만 다시 시도한다
      a.codexThread = null;
      a.current = null;
      addLog(a, { k: 'sys', text: t('이어 할 GPT 대화를 찾지 못해서 새 대화로 다시 시작해요') });
      a.queue.unshift({ id: newId(), text: cur.prompt, retried: true, quiet: true, ...carry(cur) });
      save();
    } else {
      const why = cur.errText || tail.split('\n').filter(l => l && !/codex_models_manager/.test(l)).slice(-4).join('\n');
      endTurn(a, { status: 'error', text: codexError(why || t('codex 가 예기치 않게 꺼졌어요 (종료 코드 {code})', { code })) });
    }
  }
  if (a.removed) return;
  if (!a.current && a.status !== 'idle') setStatus(a, 'idle');
  else sendAgent(a);
  pump(a);
}

// ───────────────────────── 에이전트 실행 ─────────────────────────

const LANG_NOTE = '사용자는 한국어를 씁니다. 답과 설명은 한국어로 해 주세요.';

function systemNote(a) {
  const lines = [agents.length > 1
    ? t(`당신은 '클로드 관제실'에서 동시에 일하는 에이전트 {n}명 중 "{name}"입니다. 다른 에이전트가 같은 폴더에서 함께 일할 수 있으니, 요청과 관계없는 파일은 건드리지 마세요.`, { n: agents.length, name: a.name })
    : t(`당신은 '클로드 관제실'에서 일하는 에이전트 "{name}"입니다.`, { name: a.name })];
  if (a.role.trim()) lines.push(t('맡은 역할: {role}', { role: a.role.trim() }));
  lines.push(t(LANG_NOTE));
  return lines.join('\n');
}

// 감독관 안내문. GPT(Codex) 감독관에게는 읽기 전용 샌드박스에 맞는 둘째 줄을 쓰고, 첫 글 앞에 붙인다
const supervisorNote = gpt => [
  t(`당신은 '클로드 관제실'의 감독관입니다. 다른 에이전트(일꾼)가 끝낸 일을 검토합니다.`),
  gpt ? t('파일을 직접 열어 확인하세요. 읽기 전용이라 파일을 고칠 수는 없습니다.')
    : t('읽기 도구(Read, Glob, Grep)로 파일을 직접 열어 확인하세요. 파일을 고치거나 명령을 실행할 수는 없습니다.'),
  t('시킨 일을 제대로 했는지, 버그·빠뜨린 부분·위험한 점이 있는지 봅니다. 취향 차이나 사소한 꾸밈은 문제로 삼지 마세요.'),
  t('도구 제약 때문에 확인하지 못한 것만으로는 fix 로 판정하지 마세요. 그럴 때는 summary 에 무엇을 확인하지 못했는지 적으세요. (일꾼이 같은 일을 또 해서 망가뜨릴 수 있어요)'),
  t('설명은 한국어로 짧게 하고, 마지막 줄에는 요청받은 형식의 JSON 한 줄로 판정을 적으세요.'),
].join('\n');

function write(proc, obj) {
  if (proc && !proc.ended && proc.stdin.writable) proc.stdin.write(JSON.stringify(obj) + '\n');
}

function startProc(a) {
  // --permission-prompt-tool stdio 가 있어야 허락이 필요한 일을 claude 가 혼자 거절하지 않고 이 서버(화면)에 물어본다
  // 감독관은 읽기 도구 3개만 갖고, 그 밖의 일은 묻지 않고 거절된다 (dontAsk) — 일꾼의 파일을 건드릴 수 없다
  const args = a.isSupervisor ? [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep',
    '--name', t('관제실 · {name}', { name: a.name }), '--append-system-prompt', supervisorNote(false),
  ] : [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', a.permissionMode, '--permission-prompt-tool', 'stdio',
    '--name', t('관제실 · {name}', { name: a.name }), '--append-system-prompt', systemNote(a),
  ];
  const fb = a.mode === 'fallback';
  const env = childEnv();
  if (fb) {
    // 같은 claude 프로그램을 쓰되, 요청만 Anthropic 대신 CCR 게이트웨이로 보낸다 (CCR 은 열쇠를 x-api-key 로 받는다)
    delete env.ANTHROPIC_AUTH_TOKEN;
    env.ANTHROPIC_BASE_URL = settings.fallbackUrl;
    env.ANTHROPIC_API_KEY = settings.fallbackKey || 'ccr-local';
    env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1';   // Claude 가 아닌 모델 이름도 받아 주게 (CCR 이 쓰는 설정)
    if (a.fbModel) args.push('--model', a.fbModel);
    if (a.fbSessionId) args.push('--resume', a.fbSessionId);
  } else {
    if (a.model) args.push('--model', a.model);
    if (a.effort) args.push('--effort', a.effort);
    if (a.fast && !a.isSupervisor) args.push('--settings', JSON.stringify({ fastMode: true }));   // -p 에서는 이렇게만 빠른 모드를 켤 수 있다
    if (a.sessionId) args.push('--resume', a.sessionId);
  }
  a.fastState = null;
  const [cmd, cmdArgs] = command(claude.path, args);
  const proc = spawn(cmd, cmdArgs, { cwd: a.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  proc.buf = '';
  proc.errTail = '';
  proc.ended = false;
  proc.mode = a.mode;
  a.proc = proc;
  a.dirty = false;
  proc.stdin.on('error', () => { /* 프로세스가 먼저 꺼지면 생기는 EPIPE 는 무시 */ });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', chunk => readLines(a, proc, chunk));
  proc.stderr.on('data', chunk => { proc.errTail = (proc.errTail + chunk).slice(-4000); });
  proc.on('error', err => procEnded(a, proc, null, err));
  proc.on('close', code => procEnded(a, proc, code, null));
  // SDK 와 같은 방식으로 인사부터 한다. 이래야 허락 요청이 이 서버로 온다.
  write(proc, { type: 'control_request', request_id: `init-${newId()}`, request: { subtype: 'initialize', hooks: null } });
  const where = fb ? `${t('대체 AI')}, ${a.fbModel || t('CCR 기본 모델')}${a.fbSessionId ? `, ${t('이어서')}` : ''}`
    : `${a.model || t('기본 모델')}${a.sessionId ? `, ${t('이어서')}` : ''}`;
  console.log(`[${clock()}] ${a.name}: ${t('claude 켬')} (${a.permissionMode}, ${where})`);
}

// 일이 없을 때 정상적으로 닫기 — stdin 을 닫으면 claude 가 대화를 저장하고 스스로 끝난다
function closeProc(a, proc = a.proc) {
  if (!proc) return;
  if (a.proc === proc) a.proc = null;
  try { proc.stdin.end(); } catch { /* 이미 닫힘 */ }
  setTimeout(() => forceKill(proc), 4000);
  sendAgent(a);
}

function killProc(a, proc = a.proc) {
  if (!proc) return;
  if (a.proc === proc) a.proc = null;
  try { proc.stdin.end(); } catch { /* 이미 닫힘 */ }
  forceKill(proc);
}

function forceKill(proc) {
  if (proc.ended || !proc.pid) return;
  // 윈도에서는 claude 가 띄운 명령(npm test 같은 것)까지 같이 끄려고 taskkill /T 를 쓴다
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else proc.kill('SIGKILL');
}

function readLines(a, proc, chunk) {
  proc.buf += chunk;
  let i;
  while ((i = proc.buf.indexOf('\n')) >= 0) {
    const line = proc.buf.slice(0, i).trim();
    proc.buf = proc.buf.slice(i + 1);
    if (!line.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    try { (proc.mode === 'codex' ? onCodexEvent : onEvent)(a, proc, ev); } catch (e) { console.error(t('이벤트 처리 중 오류:'), e); }
  }
}

function shortPath(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(p || '');
}

function summarizeTool(name, input) {
  input = input && typeof input === 'object' ? input : {};
  const str = v => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Bash': case 'PowerShell': return str(input.command);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return shortPath(input.file_path);
    case 'NotebookEdit': return shortPath(input.notebook_path);
    case 'Glob': return str(input.pattern);
    case 'Grep': return str(input.pattern) + (input.path ? ` · ${shortPath(input.path)}` : '');
    case 'WebFetch': return str(input.url);
    case 'WebSearch': return str(input.query);
    case 'Task': case 'Agent': return str(input.description) || str(input.prompt).slice(0, 100);
    case 'TodoWrite':
      return (Array.isArray(input.todos) ? input.todos : [])
        .map(t => `${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▸' : '☐'} ${t.content || t.activeForm || ''}`)
        .join('\n');
    default: {
      const v = Object.values(input).find(x => typeof x === 'string');
      return v ? v.slice(0, 200) : '';
    }
  }
}

function summarizeResult(name, content, isError) {
  let text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(c => (c?.type === 'text' ? c.text : c?.type === 'image' ? t('[그림]') : '')).join('\n') : '';
  text = stripAnsi(text).replace(/\r/g, '').trim();
  if (name === 'TodoWrite' && !isError) return '';
  const lines = text ? text.split('\n') : [];
  if (!isError) {
    if (name === 'Read') return t('{n}줄 읽음', { n: lines.length });
    if (name === 'Glob') return lines.length ? t('{n}개 찾음', { n: lines.length }) : t('찾은 파일 없음');
    if (name === 'Grep') return lines.length ? t('{n}줄 찾음', { n: lines.length }) : t('찾은 내용 없음');
    if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') return t('저장함');
  }
  if (!lines.length) return isError ? t('실패') : '';
  const head = lines.slice(0, 3).join('\n').slice(0, 500);
  return lines.length > 3 ? `${head}\n${t('… ({n}줄 더)', { n: lines.length - 3 })}` : head;
}

function onEvent(a, proc, ev) {
  const cur = a.current && a.current.proc === proc ? a.current : null;
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        const key = proc.mode === 'fallback' ? 'fbSessionId' : 'sessionId';
        if (ev.session_id && a[key] !== ev.session_id) { a[key] = ev.session_id; save(); }
        a.runtimeModel = ev.model || null;
        a.fastState = ev.fast_mode_state || null;   // on · cooldown · off
        if (a.fast && proc.mode !== 'fallback' && a.fastState && a.fastState !== 'on') {
          addLog(a, { k: 'sys', text: t('↯ 빠른 모드가 켜지지 않아서 보통 속도로 일해요') + fastWhy(ev.fast_mode_disabled_reason) });
        }
        sendAgent(a);
      } else if (ev.subtype === 'compact_boundary') {
        addLog(a, { k: 'sys', text: t('대화가 길어져서 앞부분을 요약했어요') });
      } else if (ev.subtype === 'notification' && typeof ev.text === 'string' && ev.text.trim()) {
        addLog(a, { k: 'sys', text: t('알림: {msg}', { msg: ev.text.trim() }) });   // 예) Fast mode disabled · usage credits exhausted
      }
      break;

    case 'stream_event': {
      if (!cur || ev.parent_tool_use_id) break;
      const e = ev.event || {};
      if (e.type === 'content_block_start') {
        const b = e.content_block || {};
        if (b.type === 'thinking' || b.type === 'redacted_thinking') setActivity(a, t('생각하는 중'));
        else if (b.type === 'text') setActivity(a, t('답을 쓰는 중'));
        else if (b.type === 'tool_use') setActivity(a, t('{tool} 준비 중', { tool: toolKo(b.name) }));
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        pushDelta(a, e.delta.text);
      }
      break;
    }

    case 'assistant': {
      flushDelta(a);
      broadcast({ type: 'delta-end', id: a.id });
      const sub = !!ev.parent_tool_use_id;   // 도우미(하위 에이전트)가 한 일
      const synthetic = ev.message?.model === '<synthetic>';   // claude 가 만든 오류 안내 — 같은 글이 결과로도 오니 한 번만 보여 준다
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text?.trim() && !sub && !synthetic) {
          const text = a.isSupervisor ? stripVerdict(b.text) : b.text.trim();   // 감독관의 판정 JSON 줄은 보고 카드로 따로 보여 준다
          if (text) addLog(a, { k: 'text', text });
        } else if (b.type === 'tool_use') {
          const summary = summarizeTool(b.name, b.input);
          a.tools.set(b.id, b.name);
          addLog(a, { k: 'tool', name: b.name, summary: summary.slice(0, 1500), sub });
          if (!sub) setActivity(a, `${toolKo(b.name)} ${firstLine(summary).slice(0, 60)}`.trim());
          if (cur && !a.isSupervisor) trackWork(a, cur, b);
        }
      }
      break;
    }

    case 'user': {
      const content = ev.message?.content;
      if (!Array.isArray(content)) break;
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const name = a.tools.get(b.tool_use_id);
        a.tools.delete(b.tool_use_id);
        const out = summarizeResult(name, b.content, b.is_error);
        if (out) addLog(a, { k: 'out', text: out, err: !!b.is_error, sub: !!ev.parent_tool_use_id });
      }
      break;
    }

    case 'result': {
      if (!cur) break;
      if (cur.stopping) endTurn(a, { status: 'stopped', ev });
      else if (!ev.is_error) {
        if (proc.mode !== 'fallback' && limit.hit) setLimit(null);   // Claude 가 다시 답했으니 한도는 풀렸다
        endTurn(a, { status: 'done', text: typeof ev.result === 'string' ? ev.result : '', ev });
      } else if (proc.mode !== 'fallback' && (cur.limited || ev.api_error_status === 429 || LIMIT_ERROR.test(String(ev.result || ''))) && fallbackReady()) {
        handOver(a, proc);   // 사용량 한도 → 오류로 끝내지 않고 대체 AI 에게 넘긴다
        break;
      } else if (proc.mode === 'fallback' && nextModel(a, proc, String(ev.result || ''))) {
        break;               // 이 대체 AI 가 실패 → 순서 목록의 다음 대체 AI 에게 넘겼다
      } else if (typeof ev.result === 'string' && ev.result.trim()) endTurn(a, { status: 'error', text: ev.result, ev });
      else {
        // 글 없는 오류는 이유가 stderr 에 남는 경우가 많아서, 프로세스가 끝나거나 잠깐 지날 때까지 기다렸다 판단한다
        cur.errorEv = ev;
        cur.errTimer = setTimeout(() => failTurn(a, proc, null), 800);
        break;
      }
      pump(a);
      break;
    }

    case 'control_request': {
      const req = ev.request || {};
      if (req.subtype === 'can_use_tool' && typeof ev.request_id === 'string') {
        const input = req.input && typeof req.input === 'object' ? req.input : {};
        const p = {
          requestId: ev.request_id,
          proc,
          tool: String(req.tool_name || t('도구')),
          input,
          summary: summarizeTool(req.tool_name, input).slice(0, 800),
          desc: typeof req.description === 'string' ? req.description.slice(0, 300) : '',   // claude 가 붙인 '이 일이 무엇인지' 설명
          suggestions: Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [],
        };
        a.pending.set(p.requestId, p);
        addLog(a, { k: 'ask', tool: p.tool, summary: p.summary });
        console.log(`[${clock()}] ${a.name}: ${t('허락 요청')} — ${toolKo(p.tool)} ${firstLine(p.summary).slice(0, 60)}`);
        setStatus(a, 'waiting');
      } else {
        write(proc, { type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: t("관제실은 '{sub}' 요청을 처리하지 않아요", { sub: req.subtype }) } });
      }
      break;
    }

    case 'control_cancel_request':
      if (a.pending.delete(ev.request_id)) {
        addLog(a, { k: 'sys', text: t('허락 요청이 취소됐어요') });
        setStatus(a, a.pending.size ? 'waiting' : a.current ? 'working' : 'idle');
      }
      break;

    case 'rate_limit_event': {
      if (proc.mode === 'fallback') break;   // CCR 쪽에서 오는 신호는 Claude 한도와 상관없다
      const info = ev.rate_limit_info || {};
      const status = info.status;
      if (status === 'rejected') {
        setLimit(Number(info.resetsAt) > 0 ? Number(info.resetsAt) * 1000 : 0);
        if (cur) cur.limited = true;
      }
      if (status && status !== rateStatus && status !== 'allowed') {
        const handing = status === 'rejected' && fallbackReady();
        broadcast({
          type: 'notice',
          level: status === 'rejected' ? (handing ? 'warn' : 'error') : 'warn',
          text: status !== 'rejected' ? t('Claude 사용량 한도에 가까워지고 있어요.')
            : handing ? t('Claude 사용량 한도에 걸렸어요. 대체 AI 가 이어서 할게요.')
            : t('Claude 사용량 한도에 걸렸어요. 설정에서 대체 AI 를 켜면 다른 AI 로 이어서 할 수 있어요.'),
        });
      }
      if (status) rateStatus = status;
      break;
    }

    default:
      break;
  }
}

function endTurn(a, { status, text = '', ev = null }) {
  const cur = a.current;
  if (!cur) return;
  a.current = null;
  clearTimeout(a.stopTimer);
  clearTimeout(cur.errTimer);
  flushDelta(a);
  broadcast({ type: 'delta-end', id: a.id });
  a.pending.clear();
  const u = ev?.usage || {};
  // 매번 다시 읽는 기본 안내문(캐시 읽기)은 빼고, 이번 일에 새로 쓴 양만 센다 — 넣으면 '5×5'에도 10만 토큰처럼 보인다
  const tokens = {
    in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    out: u.output_tokens || 0,
  };
  const ms = Date.now() - cur.startedAt;
  a.last = status;
  a.activity = '';
  a.stats.runs += 1;
  a.stats.tokensIn += tokens.in;
  a.stats.tokensOut += tokens.out;
  addLog(a, { k: 'done', status, ms, tokens, text: status === 'error' ? String(text).slice(0, 1200) : '' });
  if (!a.isSupervisor) {   // 감독관의 검토는 기록 창에 따로 남기지 않고, 검토받은 일의 기록에 판정을 붙인다
    const item = {
      id: newId(), agentId: a.id, agentName: a.name, color: a.color, prompt: cur.prompt,
      result: String(text || '').slice(0, 40000), status, at: cur.startedAt, ms, tokens, turns: ev?.num_turns ?? null,
    };
    cur.historyId = item.id;
    a.failedCarry = status === 'error' ? { historyId: item.id, ...carry(cur) } : null;   // ⇄ 로 막힌 일을 넘길 때 보고 카드·고치기 차례를 이어 가게
    history.unshift(item);
    if (history.length > HISTORY_KEEP) history.length = HISTORY_KEEP;
    broadcast({ type: 'history', item });
  }
  const byClaude = cur.proc?.mode === 'claude';   // GPT(Codex)·대체 AI 의 오류로 Claude 상태를 바꾸지 않는다
  if (status === 'error' && cur.proc?.mode !== 'codex' && AUTH_ERROR.test(text)) {
    auth = { ...auth, checked: true, loggedIn: false };
    broadcast({ type: 'auth', auth });
  }
  if (status === 'error' && cur.proc?.mode === 'codex' && codexErrorKind(text) === 'login') {
    codex = { ...codex, loggedIn: false, method: null };
    broadcast({ type: 'codex', codex });
  }
  // 대체 AI 가 꺼져 있어서 넘기지 못한 Claude 한도 오류도 화면에 한도 상태로 보여 준다
  if (status === 'error' && byClaude && LIMIT_ERROR.test(text) && !limitActive()) setLimit(0);
  console.log(`[${clock()}] ${a.name}: ${statusKo(status)} (${t('{n}초', { n: Math.round(ms / 1000) })})`);
  if (a.dirty && a.proc) closeProc(a);   // 일하는 중에 바뀐 설정은 다음 일부터 새 프로세스로
  clearTimeout(a.idleTimer);
  a.idleTimer = setTimeout(() => {
    if (!a.current && !a.queue.length && a.proc) closeProc(a);
  }, IDLE_CLOSE_MS);
  setStatus(a, 'idle');
  save();
  if (a.isSupervisor) { if (cur.review) finishReview(cur.review, status, text); }
  else if (status === 'done') requestReview(a, cur, text);
  else if (cur.reportId && !cur.handover) markReport(cur.reportId, { state: 'stopped', note: status === 'stopped' ? t('일꾼을 멈춰서 고치기를 그만뒀어요') : t('일꾼이 고치다가 오류가 났어요') });   // 다른 AI 에게 넘긴 일은 보고 카드를 그대로 이어 간다
}

function failTurn(a, proc, code) {
  const cur = a.current;
  if (!cur || cur.proc !== proc) return;
  clearTimeout(cur.errTimer);
  const tail = stripAnsi(proc.errTail).trim();
  if (!cur.stopping && proc.mode !== 'fallback' && (cur.limited || LIMIT_ERROR.test(tail)) && fallbackReady()) {
    handOver(a, proc);
    return;
  }
  if (!cur.stopping && proc.mode === 'fallback' && nextModel(a, proc, tail.split('\n').filter(Boolean).pop() || '')) return;
  if (!cur.stopping && !cur.retried && /No conversation found/i.test(tail)) {
    // 이어 하려던 대화 파일이 없어졌으면 새 대화로 한 번만 다시 시도한다
    a[proc.mode === 'fallback' ? 'fbSessionId' : 'sessionId'] = null;
    a.current = null;
    closeProc(a, proc);
    addLog(a, { k: 'sys', text: t('이어 할 대화를 찾지 못해서 새 대화로 다시 시작해요') });
    a.queue.unshift({ id: newId(), text: cur.prompt, retried: true, quiet: true, ...carry(cur) });
    save();
  } else {
    const why = code != null ? t('claude 가 예기치 않게 꺼졌어요 (종료 코드 {code})', { code }) : '';
    const lines = tail.split('\n').filter(Boolean).slice(-4).join('\n');
    endTurn(a, {
      status: cur.stopping ? 'stopped' : 'error',
      text: [why, lines].filter(Boolean).join('\n') || t('알 수 없는 오류로 작업이 끝났어요'),
      ev: cur.errorEv,
    });
  }
  pump(a);
}

function procEnded(a, proc, code, err) {
  if (proc.ended) return;
  proc.ended = true;
  if (a.proc === proc) a.proc = null;
  for (const [id, p] of a.pending) if (p.proc === proc) a.pending.delete(id);
  const cur = a.current;
  if (cur && cur.proc === proc) {
    if (err) endTurn(a, { status: 'error', text: t('claude 를 실행하지 못했어요: {why}', { why: err.message }) });
    else if (cur.stopping) endTurn(a, { status: 'stopped', ev: cur.errorEv });
    else failTurn(a, proc, code);
  }
  if (a.removed) return;
  if (!a.current && a.status !== 'idle') setStatus(a, 'idle');
  else sendAgent(a);
  pump(a);
}

// 대기열에서 다음 일을 꺼내 claude 에게 넘긴다
function pump(a) {
  if (a.current || a.removed || !a.queue.length) return;
  if (a.proc?.mode === 'codex') return;   // 지난 GPT 일의 프로세스가 아직 끝나는 중 (끝나면 codexEnded 가 다시 부른다)
  // 감독관은 검토할 때마다 그 일꾼의 폴더에서 새 대화로 시작한다 (검토끼리 섞이지 않게, 일꾼의 파일을 읽을 수 있게)
  if (a.isSupervisor && a.queue[0].review) {
    a.cwd = a.queue[0].review.cwd;
    a.engine = settings.supervisor.engine === 'codex' ? 'codex' : 'claude';
    a.model = settings.supervisor.model;
    a.gptModel = settings.supervisor.gptModel || '';
    a.sessionId = null;
    a.fbSessionId = null;
    if (a.proc) closeProc(a);
  }
  const useCodex = a.engine === 'codex';
  const problem = (useCodex
    ? (!codex.path ? t('GPT(Codex) 프로그램을 찾지 못했어요. Codex 앱을 깔거나 설정 창에서 다시 찾아 주세요.')
      : codex.loggedIn === false ? t('Codex 로그인이 필요해요. Codex 앱이나 명령창(codex login)에서 ChatGPT 로 로그인해 주세요.') : null)
    : (!claude.path ? t('claude 를 찾지 못했어요. 설정 창에서 claude 위치를 확인해 주세요.') : null))
    || (!isDir(a.cwd) ? t('작업 폴더가 없어요: {dir}\n에이전트 관리 창에서 폴더를 다시 골라 주세요.', { dir: a.cwd }) : null);
  if (problem) {
    a.queue = [];
    addLog(a, { k: 'err', text: problem });
    setStatus(a, 'idle');
    return;
  }
  clearTimeout(a.idleTimer);
  if (useCodex) {
    if (a.proc) closeProc(a);   // Claude 에서 GPT 로 막 바꿨으면 Claude 프로세스는 닫는다
  } else {
    // 한도 때문에 대체 AI 로 갔던 에이전트는 한도가 풀릴 시각이 지나면 Claude 로 돌아오고,
    // 한도 중에는 Claude 에게 보내 봐야 실패하니 처음부터 대체 AI 로 보낸다
    if (a.mode === 'fallback' && !fallbackReady()) setMode(a, 'claude', false, t('대체 AI 가 꺼져 있어서 Claude 로 돌아왔어요'));
    else if (a.mode === 'fallback' && a.autoMode && !limitActive()) setMode(a, 'claude', false, t('Claude 사용량 한도가 풀렸을 시각이라 다시 Claude 가 맡아요'));
    else if (a.mode === 'claude' && limitActive() && fallbackReady()) setMode(a, 'fallback', true, t('Claude 사용량 한도 중이라 이번 일은 대체 AI 가 맡아요'));
    // 새 일은 대체 AI 순서 목록에서 지금 쓸 수 있는 첫 모델로 시작한다 (실패해서 넘겨받은 일은 이미 모델이 정해져 있다)
    if (a.mode === 'fallback' && !a.queue[0].tried) {
      const model = pickFallbackModel();
      if (model !== a.fbModel) {
        a.fbModel = model;
        a.fbSessionId = null;   // 모델이 바뀌면 다른 AI 의 대화와 섞지 않는다
        if (a.proc) closeProc(a);
      }
    }
    if (a.proc && a.dirty) closeProc(a);
    if (!a.proc) {
      try {
        startProc(a);
      } catch (e) {
        a.queue = [];
        addLog(a, { k: 'err', text: t('claude 를 실행하지 못했어요: {why}', { why: e.message }) });
        setStatus(a, 'idle');
        return;
      }
    }
  }
  const item = a.queue.shift();
  a.current = {
    prompt: item.text, startedAt: Date.now(), proc: useCodex ? null : a.proc, retried: !!item.retried, tried: item.tried,
    review: item.review,                 // 감독관: 지금 검토하는 일
    round: item.round || 0,              // 일꾼: 감독관이 몇 번째로 고치게 한 일인지
    task: item.task || item.text,        // 일꾼: 처음 시킨 일 (고치기를 여러 번 해도 그대로)
    reportId: item.reportId,             // 일꾼: 감독관이 고치라고 한 일이면 그 보고 카드
    files: item.files ? new Set(item.files) : undefined,   // 넘겨받은 일이면 앞 AI 가 고친 파일부터
    commands: item.commands ? [...item.commands] : undefined,
  };
  if (item.review?.reportId) markReport(item.review.reportId, { state: 'reviewing' });
  // 인수인계 쪽지: 지난 일과 다른 AI(Claude ↔ 대체 AI ↔ GPT)가 맡으면, 새 AI 에게 지난 일을 먼저 알려 준다
  const ai = aiOf(a, useCodex);
  const fresh = !a.isSupervisor && a.lastAi && a.lastAi !== ai ? handoffNote(a, a.lastAi, ai, item.takeover) : '';
  const note = fresh || item.note || '';   // 같은 AI 가 같은 일을 새 대화로 다시 하면 처음 건넨 쪽지를 다시 건넨다
  a.current.note = note;
  if (!item.quiet) addLog(a, { k: 'user', text: item.text });
  if (fresh) addLog(a, { k: 'sys', text: t('인수인계 쪽지를 건넸어요 ({from} → {to})', { from: aiKo(a.lastAi), to: aiKo(ai) }) });
  else if (note) addLog(a, { k: 'sys', text: t('새 대화로 다시 해서 인수인계 쪽지를 다시 건넸어요') });
  if (!a.isSupervisor && a.lastAi !== ai) { a.lastAi = ai; save(); }
  let text = note + item.text;
  if (useCodex) {
    // Codex 에는 붙일 시스템 안내 칸이 없어서, 새 대화의 첫 글 앞에 같은 안내를 붙인다
    // 어느 폴더에서 일하는지 전체 경로로 알려 준다 (그 밖에는 샌드박스가 쓰기를 막는다)
    const where = t('작업 폴더: {dir} (파일은 이 폴더 안에서만 만들고 고칠 수 있어요)', { dir: a.cwd });
    if (a.isSupervisor) text = `${supervisorNote(true)}\n${where}\n\n${text}`;
    else if (!a.codexThread) text = `${t('[관제실 안내]')}\n${systemNote(a)}\n${where}\n\n${text}`;
    else if (a.langNote) text = `${t('[관제실 안내]')}\n${t(LANG_NOTE)}\n\n${text}`;   // 언어를 바꾼 뒤 이어 하는 GPT 대화에는 새 언어를 알려 준다
    a.langNote = false;
    try {
      startCodexTurn(a, text);
    } catch (e) {
      endTurn(a, { status: 'error', text: t('codex 를 실행하지 못했어요: {why}', { why: e.message }) });
      return;
    }
  } else {
    const sid = a.proc.mode === 'fallback' ? a.fbSessionId : a.sessionId;
    write(a.proc, { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: sid || '' });
  }
  a.activity = t('시작하는 중');
  setStatus(a, 'working');
  console.log(`[${clock()}] ${a.name}: ${t('일 시작')}${useCodex ? ' (GPT)' : ''} — ${firstLine(item.text).slice(0, 50)}`);
}

// ───────────────────────── 대체 AI (Claude 사용량 한도) ─────────────────────────

const limitUntil = () => limit.until || limit.at + LIMIT_GUESS_MS;
const limitActive = () => limit.hit && Date.now() < limitUntil();
const fallbackReady = () => !!settings.fallbackEnabled && /^https?:\/\/\S+$/i.test(settings.fallbackUrl || '');

function setLimit(until) {
  limit = until === null ? { hit: false, until: 0, at: 0 } : { hit: true, until, at: Date.now() };
  broadcast({ type: 'limit', limit });
}

// 에이전트가 일을 맡길 곳(Claude / 대체 AI)을 바꾼다. 일하는 중이면 지금 일이 끝난 뒤부터 바뀐다.
function setMode(a, mode, auto, note) {
  if (a.mode === mode) return;
  a.mode = mode;
  a.autoMode = !!auto && mode === 'fallback';
  if (a.proc) {
    if (a.current) a.dirty = true;
    else closeProc(a);
  }
  if (note) addLog(a, { k: 'sys', text: note });
  console.log(`[${clock()}] ${a.name}: ${t('{ai} 로 바꿈', { ai: mode === 'fallback' ? t('대체 AI') : 'Claude' })}`);
  sendAgent(a);
  save();
}

// 사용량 한도에 걸린 일을 오류로 끝내지 않고, 같은 일을 대체 AI 에게 넘긴다 (쪽지로 하던 일을 이어서 하게)
function handOver(a, proc) {
  const cur = a.current;
  if (!cur) return;
  clearTimeout(cur.errTimer);
  clearTimeout(a.stopTimer);
  a.current = null;
  flushDelta(a);
  broadcast({ type: 'delta-end', id: a.id });
  a.pending.clear();
  if (!limitActive()) setLimit(0);
  setMode(a, 'fallback', true, t('Claude 사용량 한도에 걸렸어요. 같은 일을 대체 AI 가 이어서 할게요.'));
  if (a.proc === proc) closeProc(a, proc);
  a.queue.unshift({ id: newId(), text: cur.prompt, quiet: true, takeover: 'running', ...carry(cur) });
  a.activity = '';
  setStatus(a, 'idle');
  pump(a);
}

// 같은 일을 다시 맡길 때(한도·모델 바꿈·대화 잃음) 감독관 검토 정보도 그대로 넘긴다
const carry = cur => ({
  round: cur.round, task: cur.task, review: cur.review, reportId: cur.reportId,
  files: cur.files ? [...cur.files] : undefined, commands: cur.commands ? [...cur.commands] : undefined,   // 앞 AI 가 이미 고친 것도 감독관이 보게
  note: cur.note,   // 이어 할 대화를 잃거나 대체 AI 모델이 바뀌어 새 대화로 다시 해도 인수인계 쪽지를 잃지 않게
});

// 순서 목록에서 15분 안에 실패한 적 없는 첫 모델 (목록이 비어 있으면 null = CCR 기본 모델)
function pickFallbackModel() {
  const list = settings.fallbackModels;
  if (!list.length) return null;
  const now = Date.now();
  return list.find(m => !(modelCooldown.get(m) > now)) || list[0];
}

// 대체 AI 모델이 실패하면 순서 목록의 다음 모델에게 같은 일을 처음부터 다시 맡긴다. 넘길 곳이 없으면 false.
function nextModel(a, proc, reason) {
  const cur = a.current;
  if (!cur) return false;
  const failed = a.fbModel || '';
  if (failed) modelCooldown.set(failed, Date.now() + MODEL_COOLDOWN_MS);
  const tried = new Set([...(cur.tried || []), failed]);
  const next = settings.fallbackModels.find(m => !tried.has(m));
  if (!next) return false;
  clearTimeout(cur.errTimer);
  clearTimeout(a.stopTimer);
  a.current = null;
  flushDelta(a);
  broadcast({ type: 'delta-end', id: a.id });
  a.pending.clear();
  if (a.proc === proc) closeProc(a, proc);
  a.fbModel = next;
  a.fbSessionId = null;
  const why = firstLine(reason).slice(0, 100);
  addLog(a, { k: 'sys', text: t('{failed}에서 막혀서 다음 대체 AI({next})로 넘겨요', { failed: failed || t('CCR 기본 모델'), next }) + (why ? `\n${t('이유: {why}', { why })}` : '') });
  console.log(`[${clock()}] ${a.name}: ${t('대체 AI {failed} 실패 → {next}', { failed: failed || t('기본'), next })}`);
  a.queue.unshift({ id: newId(), text: cur.prompt, quiet: true, tried: [...tried], ...carry(cur) });
  a.activity = '';
  setStatus(a, 'idle');
  save();
  pump(a);
  return true;
}

// ── CCR 을 창 없이 직접 돌리기 ──
// 'ccr start/ui' 의 백그라운드 서비스는 콘솔 없이(detached) 뜨고, 게이트웨이를 띄울 때 창 숨기기를 빼먹어서
// 윈도에서는 빈 node 콘솔 창이 생긴다. 그 창을 닫으면 게이트웨이가 죽고 다시 떠서 창이 또 생긴다 (CCR 버그).
// 그래서 관제실이 'ccr serve' 를 숨긴 콘솔에서 직접 돌린다 — 게이트웨이도 숨은 콘솔을 물려받아 창이 안 생긴다.
let ccrProc = null;     // 관제실이 직접 켠 ccr serve
let ccrUiUrl = null;    // 그 CCR 이 출력한 관리 화면 주소 (로그인 열쇠가 붙어 있어 화면으로 보내지 않는다)
let ccrStarting = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// npm 으로 깔린 ccr.cmd 옆 node_modules 에서 실제 프로그램(cli.js)을 찾는다 — 셸 없이 node 로 바로 돌리려고
function ccrCli() {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ccr'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const f of out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      const pkg = path.join(path.dirname(f), 'node_modules', '@musistudio', 'claude-code-router');
      const bin = readJson(path.join(pkg, 'package.json'))?.bin?.ccr;
      if (bin && fs.existsSync(path.join(pkg, bin))) return path.join(pkg, bin);
    }
  } catch { /* ccr 이 없음 */ }
  return null;
}

const runCcr = (cli, args) => new Promise(resolve => {
  execFile(process.execPath, [cli, ...args], { env: childEnv(), windowsHide: true, timeout: 20000 }, () => resolve());
});

function startCcr() {
  if (ccrStarting) return ccrStarting;
  ccrStarting = (async () => {
    if (ccrProc && !ccrProc.ended) return true;
    const cli = ccrCli();
    if (!cli) return false;
    await runCcr(cli, ['stop']);   // 창을 띄우는 백그라운드 서비스가 켜져 있으면 먼저 끈다 (없으면 아무 일도 안 함)
    const proc = spawn(process.execPath, [cli, 'serve', '--no-open'], { env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.ended = false;
    ccrProc = proc;
    ccrUiUrl = null;
    let buf = '';
    const onOut = d => {
      buf = (buf + d).slice(-4000);
      const m = buf.match(/https?:\/\/[^\s"']+ccr_web_token=[^\s"']+/);
      if (m) ccrUiUrl = m[0];
    };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onOut);
    proc.on('error', () => { /* close 에서 처리 */ });
    proc.on('close', code => {
      proc.ended = true;
      if (ccrProc === proc) { ccrProc = null; ccrUiUrl = null; }
      console.log(`[${clock()}] ${t('CCR 꺼짐 (코드 {code})', { code })}`);
      checkCcr();
    });
    console.log(`[${clock()}] ${t('CCR 켬 (창 없이)')}`);
    // 관리 화면 주소가 나오고 게이트웨이가 대답할 때까지 최대 15초 기다린다
    for (let i = 0; i < 30 && !proc.ended; i++) {
      await sleep(500);
      if (ccrUiUrl && !(await checkCcr()).down) break;
    }
    return !proc.ended;
  })().finally(() => { ccrStarting = null; });
  return ccrStarting;
}

// CCR 게이트웨이가 켜져 있고 열쇠가 맞는지 확인한다 (모델 목록도 받아 와서 설정 화면에 보여 준다)
async function checkCcr() {
  const headers = settings.fallbackKey ? { 'x-api-key': settings.fallbackKey, authorization: `Bearer ${settings.fallbackKey}` } : {};
  try {
    const res = await fetch(new URL('/v1/models', settings.fallbackUrl), { headers, signal: AbortSignal.timeout(4000) });
    let models = [];
    if (res.ok) {
      const data = await res.json().catch(() => null);
      models = (Array.isArray(data?.data) ? data.data : []).map(m => m.id).filter(Boolean).slice(0, 50);
    }
    ccr = {
      checked: true, ok: res.ok, models,
      error: res.ok ? '' : res.status === 401 || res.status === 403 ? t('CCR 열쇠가 맞지 않아요') : t('CCR 게이트웨이가 {status} 오류를 냈어요', { status: res.status }),
    };
  } catch {
    ccr = { checked: true, ok: false, down: true, models: [], error: t('CCR 게이트웨이가 꺼져 있어요') };
  }
  broadcast({ type: 'ccr', ccr });
  return ccr;
}

// 대체 AI 를 켜 두었으면 관제실이 CCR 을 창 없이 직접 켠다.
// 이미 다른 방법(ccr ui/start)으로 켜진 CCR 이 있으면 그건 끄고 바꿔 띄운다 — 그쪽은 빈 창을 띄우기 때문이다.
async function ensureCcr() {
  if (!settings.fallbackEnabled) return;
  if (process.platform === 'win32' && !(ccrProc && !ccrProc.ended)) await startCcr();
  await checkCcr();
}

// CCR 이 스스로 만든 게이트웨이 열쇠(Local Gateway)를 CCR 설정 파일에서 읽어 온다.
// 열쇠가 암호화돼 있지 않을 때(plain)만 가능하다. Node 에 들어 있는 sqlite 를 읽기 전용으로 쓴다.
function importCcrKey() {
  const dir = process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'claude-code-router') : path.join(os.homedir(), '.claude-code-router');
  const file = path.join(dir, 'config.sqlite');
  if (!fs.existsSync(file)) return { error: t('CCR 설정 파일을 찾지 못했어요. CCR 을 한 번 켜 주세요.') };
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('select id, name, encrypted_key as value, encryption, expires_at as expires from api_keys').all();
    const usable = rows.filter(r => r.encryption === 'plain' && r.value && !(r.expires && Date.parse(r.expires) < Date.now()));
    const pick = usable.find(r => r.id === 'local-gateway') || usable[0];
    if (!pick) return { error: rows.length ? t('CCR 열쇠가 암호화돼 있어서 가져올 수 없어요. 직접 붙여 넣어 주세요.') : t('CCR 에 열쇠가 없어요. CCR 화면의 API Keys 에서 하나 만들어 주세요.') };
    settings.fallbackKey = String(pick.value);
    return { name: pick.name || pick.id };
  } catch (e) {
    return { error: t('CCR 설정을 읽지 못했어요: {why}', { why: e.message }) };
  } finally {
    try { db?.close(); } catch { /* 이미 닫힘 */ }
  }
}

async function openCcrUi() {
  if (process.platform !== 'win32') return t('터미널에서 ccr ui 를 실행해 주세요.');
  if (!ccrCli()) return t('claude-code-router 가 설치돼 있지 않아요. (npm install -g @musistudio/claude-code-router)');
  if (!(ccrProc && !ccrProc.ended)) await startCcr();
  for (let i = 0; i < 20 && !ccrUiUrl; i++) await sleep(300);
  if (!ccrUiUrl) return t('CCR 관리 화면 주소를 받지 못했어요. 잠시 뒤에 다시 눌러 주세요.');
  spawn('explorer.exe', [ccrUiUrl], { detached: true, stdio: 'ignore' }).unref();   // 기본 브라우저로 연다
  return null;
}

// ───────────────────────── 감독관 ─────────────────────────

const josa = (word, withBatchim, without) => {
  const ch = String(word).trim().slice(-1);
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? withBatchim : without;
  if (/\d/.test(ch)) return '013678'.includes(ch) ? withBatchim : without;
  return `${withBatchim}(${without})`;
};

const fileOwners = new Map();   // 고친 파일 → { agentId, at } — 두 일꾼이 같은 파일을 고치면 경고하려고
const warned = new Map();       // 같은 경고를 10분 안에 또 띄우지 않으려고
const CONFLICT_MS = 10 * 60 * 1000;

// 일꾼이 이번 일에서 고친 파일과 돌린 명령을 모아 둔다 (감독관 검토 자료)
function trackWork(a, cur, b) {
  const input = b.input || {};
  const file = input.file_path || input.notebook_path;
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name) && typeof file === 'string') {
    (cur.files ||= new Set()).add(file);
    watchFile(a, file);
  }
  if (/^(Bash|PowerShell)$/.test(b.name) && typeof input.command === 'string') (cur.commands ||= []).push(input.command.slice(0, 300));
}

// AI 없이 하는 감시: 10분 안에 다른 일꾼도 고친 파일이면 서로 덮어쓸 수 있다고 알린다
function watchFile(a, file) {
  const key = path.resolve(a.cwd, file).toLowerCase();
  const prev = fileOwners.get(key);
  fileOwners.set(key, { agentId: a.id, at: Date.now() });
  if (!prev || prev.agentId === a.id || Date.now() - prev.at > CONFLICT_MS) return;
  const other = agents.find(x => x.id === prev.agentId);
  const pairKey = `${key}|${[a.id, prev.agentId].sort().join()}`;
  if (!other || Date.now() - (warned.get(pairKey) || 0) < CONFLICT_MS) return;
  warned.set(pairKey, Date.now());
  const short = shortPath(file);
  const pair = { a: a.name, wa: josa(a.name, '과', '와'), b: other.name, ga: josa(other.name, '이', '가'), file: short };
  addLog(a, { k: 'sys', text: t('⚠ {b}도 10분 안에 이 파일을 고쳤어요: {file} — 서로 덮어쓸 수 있어요', pair) });
  addLog(other, { k: 'sys', text: t('⚠ {a}{ga} 방금 이 파일을 고쳤어요: {file} — 서로 덮어쓸 수 있어요', { ...pair, ga: josa(a.name, '이', '가') }) });
  addLog(supervisor, { k: 'sys', text: t('감시: {a}{wa} {b}{ga} 같은 파일({file})을 고치고 있어요', pair) });
  broadcast({ type: 'notice', level: 'warn', text: t('{a}{wa} {b}{ga} 같은 파일({file})을 고치고 있어요. 서로 덮어쓸 수 있어요.', pair) });
}

// ── 감독관 보고 카드: 일꾼이 한 일을 감독관이 요약해서 올린다 ──

function markReport(id, patch) {
  const r = reports.find(x => x.id === id);
  if (!r) return null;   // 그사이 기록을 지웠으면 그냥 둔다
  Object.assign(r, patch, { updatedAt: Date.now() });
  broadcast({ type: 'report', report: r });
  save();
  return r;
}

// 끝나지 않은 보고인데 그 일을 들고 있는 에이전트가 없으면(대기열을 비웠거나 에이전트를 지웠으면) 끊긴 것으로 닫는다.
// 일꾼이 끝남 → 감독관 대기열에 넣음처럼 상태가 넘어가는 도중에 보지 않도록 한 박자 늦게 본다.
let sweepQueued = false;
function scheduleSweep() {
  if (sweepQueued) return;
  sweepQueued = true;
  setImmediate(() => {
    sweepQueued = false;
    const holds = (item, id) => !!item && (item.reportId === id || item.review?.reportId === id);
    for (const r of reports) {
      if (!REPORT_LIVE.includes(r.state)) continue;
      if (allAgents().some(a => holds(a.current, r.id) || a.queue.some(q => holds(q, r.id)))) continue;
      markReport(r.id, { state: 'stopped', note: r.state === 'fixing' ? t('일꾼이 고치던 일이 멈췄어요') : t('검토가 중간에 멈췄어요') });
    }
  });
}

// 감독관 답에서 판정 JSON 줄을 뺀 설명만 남긴다 (```json 으로 감싼 경우도)
function stripVerdict(text) {
  return String(text || '').split('\n').filter(l => !/^\s*\{.*"verdict"/.test(l)).join('\n')
    .replace(/```[a-z]*\s*```/gi, '').trim();
}

// 보고 카드에는 작업 폴더 안의 파일을 짧게 적는다
function relFile(cwd, file) {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : shortPath(file);
}

// 일꾼이 일을 끝내면 감독관에게 검토를 맡긴다. 파일도 안 고치고 명령도 안 돌린 일(질문·답)은 건너뛴다.
function requestReview(a, cur, text) {
  const files = [...(cur.files || [])];
  const commands = cur.commands || [];
  let r = cur.reportId && reports.find(x => x.id === cur.reportId);
  if (!settings.supervisor.enabled || !supervisor) {
    if (r) markReport(r.id, { state: 'stopped', note: t('감독관을 꺼서 고친 뒤 다시 보지 않았어요') });
    return;
  }
  if (!files.length && !commands.length && !r) return;   // 감독관이 고치라고 한 일은 바뀐 게 없어도 다시 본다
  const round = cur.round || 0;
  if (!r) {
    r = { id: newId(), workerId: a.id, workerName: a.name, color: a.color, task: String(cur.task || '').slice(0, 300),
      work: '', summary: '', fix: '', note: '', files: [], steps: [], at: Date.now() };
    reports.unshift(r);
    if (reports.length > REPORT_KEEP) reports.length = REPORT_KEEP;
  }
  markReport(r.id, {
    state: 'queued', round, max: settings.supervisor.maxRounds, note: '',
    files: [...new Set([...r.files, ...files.map(f => relFile(a.cwd, f))])].slice(0, 12),
  });
  const none = t('- (없음)');
  const prompt = [
    t('[검토 요청] 일꾼 "{name}"{ga} 일을 끝냈어요. 지금 폴더가 그 일꾼의 작업 폴더예요.', { name: a.name, ga: josa(a.name, '이', '가') }),
    '', t('## 사용자가 시킨 일'), cur.task,
    ...(round ? ['', t('## 이번은 감독관이 고치게 한 {n}번째 수정이에요. 이번에 시킨 내용', { n: round }), cur.prompt] : []),
    '', t('## 일꾼이 만들거나 고친 파일'), ...(files.length ? files.map(f => `- ${f}`) : [none]),
    '', t('## 일꾼이 실행한 명령'), ...(commands.length ? commands.map(c => `- ${c}`) : [none]),
    '', t('## 일꾼의 마지막 보고'), String(text || t('(없음)')).slice(0, 4000),
    '', t('위 파일을 직접 읽어서 시킨 일을 제대로 했는지, 버그·빠뜨린 것·위험한 점이 있는지 확인하세요.'),
    t('짧게 설명한 뒤 마지막 줄에 아래 형식의 JSON 한 줄만 적으세요.'),
    t('{"verdict":"pass","work":"일꾼이 한 일","summary":"판정 한 문장","fix":""}'),
    t('work 에는 일꾼이 실제로 만들거나 고친 것과 그 결과를 사용자에게 보고하듯 1~2문장으로 적으세요. 관제실 보고판에 그대로 올라가요.'),
    t('summary 에는 판정 이유를 한 문장으로 적으세요.'),
    t('고칠 게 있으면 verdict 를 "fix" 로 하고, fix 에 일꾼에게 그대로 전할 구체적인 수정 지시를 적으세요.'),
  ].join('\n');
  supervisor.queue.push({ id: newId(), text: prompt, quiet: true, review: { workerId: a.id, workerName: a.name, cwd: a.cwd, round, task: cur.task, historyId: cur.historyId, reportId: r.id } });
  const after = round ? ` ${t('({n}번째 수정 뒤)', { n: round })}` : '';
  addLog(a, { k: 'sys', text: t('감독관에게 검토를 맡겼어요') + after });
  addLog(supervisor, { k: 'user', text: `${t('{name} 검토', { name: a.name })}${after} — ${firstLine(cur.task).slice(0, 80)}` });
  sendAgent(supervisor);
  pump(supervisor);
}

// 감독관 답의 마지막 JSON 한 줄에서 판정을 읽는다
function parseVerdict(text) {
  const lines = String(text || '').split('\n').filter(l => l.includes('"verdict"')).reverse();
  for (const line of lines) {
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const v = JSON.parse(line.slice(start, end + 1));
      if (v.verdict === 'pass' || v.verdict === 'fix') {
        return {
          verdict: v.verdict, work: String(v.work || '').slice(0, 500),
          summary: String(v.summary || '').slice(0, 300), fix: String(v.fix || '').slice(0, 3000),
        };
      }
    } catch { /* 다음 줄 */ }
  }
  return null;
}

function finishReview(review, status, text) {
  const worker = agents.find(x => x.id === review.workerId);
  const rid = review.reportId;
  if (!worker) {
    if (rid) markReport(rid, { state: 'stopped', note: t('검토하는 동안 일꾼이 지워졌어요') });
    return;
  }
  if (status !== 'done') {
    addLog(worker, { k: 'sys', text: t('감독관 검토가 끝나지 못했어요 ({status})', { status: statusKo(status) }) });
    if (rid) markReport(rid, { state: 'stopped', note: status === 'stopped' ? t('감독관 검토를 멈췄어요') : t('감독관이 검토하다가 오류가 났어요') });
    return;
  }
  const v = parseVerdict(text);
  if (!v) {
    addLog(worker, { k: 'sys', text: t('감독관의 판정을 읽지 못했어요 — 감독관 칸에서 내용을 확인해 주세요') });
    if (rid) markReport(rid, { state: 'stopped', note: t('감독관의 판정을 읽지 못했어요 — 감독관 칸의 검토 과정을 확인해 주세요') });
    return;
  }
  const h = history.find(x => x.id === review.historyId);
  if (h) {
    h.review = { verdict: v.verdict, work: v.work, summary: v.summary, round: review.round };
    broadcast({ type: 'history-update', item: h });
    save();
  }
  // 보고 카드: 한 일(work)은 가장 최근 검토 것으로, 판정은 차례(steps)로 쌓는다
  const r = rid && reports.find(x => x.id === rid);
  const report = patch => {
    if (!r) return;
    const steps = [...(r.steps || []), { round: review.round, verdict: v.verdict, summary: v.summary }].slice(-6);
    markReport(rid, { work: v.work || r.work, summary: v.summary, fix: v.fix, steps, note: '', ...patch });
  };
  console.log(`[${clock()}] ${t('감독관')}: ${worker.name} ${v.verdict === 'pass' ? t('통과') : t('수정 요청')} — ${v.summary.slice(0, 60)}`);
  if (v.verdict === 'pass') {
    addLog(worker, { k: 'sys', text: t('✓ 감독관 검토 통과 — {summary}', { summary: v.summary }) });
    addLog(supervisor, { k: 'sys', text: t('판정: {name} 통과 — {summary}', { name: worker.name, summary: v.summary }) });
    report({ state: 'pass' });
    return;
  }
  const max = settings.supervisor.maxRounds;
  if (review.round >= max) {
    addLog(worker, { k: 'sys', text: t('⚠ 감독관이 {max}번 고치게 했는데도 문제가 남았어요 — 직접 확인해 주세요\n{summary}', { max, summary: v.summary }) });
    addLog(supervisor, { k: 'sys', text: t('판정: {name}의 일에 고칠 점이 남았어요 ({max}번 고치게 함) — {summary}', { name: worker.name, max, summary: v.summary }) });
    broadcast({ type: 'notice', level: 'warn', text: t('{name}의 일에 아직 문제가 남아 있어요. 감독관 칸과 기록을 확인해 주세요.', { name: worker.name }) });
    report({ state: 'left', note: t('{max}번 고치게 했는데도 문제가 남았어요. 직접 확인해 주세요.', { max }) });
    return;
  }
  addLog(worker, { k: 'sys', text: t('감독관이 고칠 점을 찾았어요 — {summary}', { summary: v.summary }) });
  addLog(supervisor, { k: 'sys', text: t('판정: {name}에게 다시 고치게 해요 ({n}/{max}) — {summary}', { name: worker.name, n: review.round + 1, max, summary: v.summary }) });
  report({ state: 'fixing', round: review.round + 1, max });
  worker.queue.push({ id: newId(), text: `${t('[감독관 수정 요청 {n}/{max}]', { n: review.round + 1, max })} ${v.fix || v.summary}`, round: review.round + 1, task: review.task, reportId: rid });
  sendAgent(worker);
  pump(worker);
}

function enqueue(a, text) {
  a.queue.push({ id: newId(), text });
  sendAgent(a);
  pump(a);
}

function stopAgent(a) {
  const hadQueue = a.queue.length > 0;
  a.queue = [];
  const cur = a.current;
  if (!cur) {
    if (hadQueue) sendAgent(a);
    return;
  }
  if (cur.stopping) return;
  cur.stopping = true;
  const proc = cur.proc;
  if (!proc || proc.ended) {
    endTurn(a, { status: 'stopped' });
    return;
  }
  if (proc.mode === 'codex') {   // GPT 는 일마다 따로 띄운 프로세스라 그냥 끈다 (끝나면 codexEnded 가 '중지됨'으로 마무리)
    a.activity = t('멈추는 중');
    setStatus(a, 'working');
    forceKill(proc);
    return;
  }
  for (const [id, p] of a.pending) {
    write(p.proc, { type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'deny', message: t('사용자가 작업을 멈췄어요.'), interrupt: true } } });
  }
  a.pending.clear();
  write(proc, { type: 'control_request', request_id: `stop-${newId()}`, request: { subtype: 'interrupt' } });
  a.activity = t('멈추는 중');
  setStatus(a, 'working');
  clearTimeout(a.stopTimer);
  a.stopTimer = setTimeout(() => { if (a.current === cur) killProc(a, proc); }, 6000);
}

function resetAgent(a) {
  a.queue = [];
  if (a.current) stopAgent(a);
  if (a.proc) killProc(a);
  a.sessionId = null;
  a.codexThread = null;
  a.runtimeModel = null;
  a.dirty = false;
  a.tools.clear();
  addLog(a, { k: 'sys', text: t('― 새 대화를 시작해요 ―') });
  sendAgent(a);
  save();
}

function removeAgent(a) {
  a.removed = true;
  a.queue = [];
  clearTimeout(a.idleTimer);
  if (a.proc) killProc(a);
  agents = agents.filter(x => x !== a);
  sendAgents();
  save();
}

// ⇄ 다른 AI 에게 넘기기: 에이전트의 AI 를 바로 바꾸고, 하던 일(또는 오류로 막힌 마지막 일)을 새 AI 가 이어서 하게 한다.
// 새 AI 는 pump 에서 인수인계 쪽지(지난 일·마지막 말·고친 파일)를 먼저 받는다. 기다리던 다른 일은 그대로 둔다.
function apiHandover(a, b) {
  const target = b.target;
  const want = { claude: 'claude', codex: 'gpt', fallback: 'fallback' }[target];
  if (!want) return fail(400, t('Claude·GPT·대체 AI 중에 골라 주세요'));
  if (target === 'claude' && !claude.path) return fail(400, t('claude 를 찾지 못했어요. 설정 창에서 확인해 주세요.'));
  if (target === 'codex' && (!codex.path || codex.loggedIn === false)) return fail(400, t('GPT(Codex)를 쓸 수 없어요. 설정 창에서 Codex 로그인을 확인해 주세요.'));
  if (target === 'fallback' && !fallbackReady()) return fail(400, t('대체 AI 가 꺼져 있어요. 설정 창에서 먼저 켜 주세요.'));
  const now = aiOf(a, a.engine === 'codex');
  if (now === want) return fail(400, t('이미 {ai}가 맡고 있어요', { ai: aiKo(want) }));
  const cur = a.current;
  // 앞 AI 가 아직 멈추는 중에 또 넘기면, 앞서 넣어 둔 그 일은 빼고 새로 넣는다 (같은 일이 두 번 돌지 않게)
  const keep = a.queue.filter(q => q !== cur?.handover);
  let item = null;
  if (cur) {
    item = { id: newId(), text: cur.prompt, takeover: 'running', ...carry(cur) };
    cur.handover = item;   // endTurn 은 이걸 보고 보고 카드를 닫지 않는다
    stopAgent(a);   // 대기열을 비우니 아래에서 되돌린다. 멈춘 일이 끝나면 pump 가 넘긴 일을 꺼낸다.
  } else if (a.last === 'error') {
    const h = history.find(x => x.agentId === a.id);
    if (h?.status === 'error') {
      // 감독관이 돌려보낸 고치기가 막힌 거면 같은 보고 카드·차례로 이어 간다 (앱을 다시 켜기 전까지만 기억한다)
      const c = a.failedCarry?.historyId === h.id ? a.failedCarry : {};
      item = { ...carry(c), id: newId(), text: h.prompt, takeover: 'failed' };
      if (c.reportId) markReport(c.reportId, { state: 'fixing', note: '' });
    }
  }
  if (target === 'codex') {
    a.engine = 'codex';
    setMode(a, 'claude', false, '');   // 나중에 Claude 모델을 고르면 대체 AI 가 아니라 Claude 로 가게
  } else {
    a.engine = 'claude';
    if (target === 'claude' && limit.hit) setLimit(null);   // 직접 Claude 로 넘긴다는 건 한도가 풀렸다고 보는 것 (Claude로 되돌리기와 같다)
    setMode(a, target, false, '');
  }
  if (a.engine === 'codex') a.fast = false;
  a.queue = item ? [item, ...keep] : keep;
  const how = !item ? t(' — 다음 일부터 맡아요') : item.takeover === 'running' ? t(' — 하던 일을 넘겨서 이어서 해요') : t(' — 막힌 일을 새 AI 가 다시 해요');
  addLog(a, { k: 'sys', text: t('⇄ {from}에서 {to}로 바꿨어요', { from: aiKo(now), to: aiKo(want) }) + how });
  console.log(`[${clock()}] ${a.name}: ${aiKo(now)} → ${aiKo(want)} ${t('넘기기')}${item ? ` (${item.takeover})` : ''}`);
  sendAgent(a);
  save();
  pump(a);
  return [200, { ok: true, moved: item ? item.takeover : null }];
}

function answerPermission(a, requestId, decision) {
  const p = a.pending.get(requestId);
  if (!p) return false;
  a.pending.delete(requestId);
  let response;
  if (decision === 'deny') {
    response = { behavior: 'deny', message: t('사용자가 관제실에서 거절했어요.') };
  } else {
    response = { behavior: 'allow', updatedInput: p.input };
    // '계속 허락'은 claude 가 제안한 규칙을 이번 대화(session)에만 적용한다 — 설정 파일에는 쓰지 않는다
    if (decision === 'always' && p.suggestions.length) response.updatedPermissions = p.suggestions.map(s => ({ ...s, destination: 'session' }));
  }
  write(p.proc, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  const verb = decision === 'deny' ? t('거절') : decision === 'always' ? t('계속 허락') : t('허락');
  addLog(a, { k: 'sys', text: `${verb} · ${toolKo(p.tool)} ${firstLine(p.summary).slice(0, 80)}` });
  setStatus(a, a.pending.size ? 'waiting' : a.current ? 'working' : 'idle');
  return true;
}

const load = a => (a.current ? 1 : 0) + a.queue.length;
function pickAgent() {
  return agents.reduce((best, a) => (load(a) < load(best) ? a : best), agents[0]);
}

// ───────────────────────── 윈도 도우미 ─────────────────────────

function pickFolder(initial, purpose) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const desc = purpose === 'data' ? t('설정과 기록을 저장할 폴더를 골라 주세요') : t('에이전트가 일할 폴더를 골라 주세요');
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = $env:PICK_DESC',
    '$d.ShowNewFolderButton = $true',
    'if ($env:PICK_START -and (Test-Path -LiteralPath $env:PICK_START)) { $d.SelectedPath = $env:PICK_START }',
    "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
  ].join('; ');
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      env: { ...process.env, PICK_START: typeof initial === 'string' ? initial : '', PICK_DESC: desc },
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
    }, (err, out) => resolve(String(out || '').trim() || null));
  });
}

function openFolder(dir) {
  if (!isDir(dir)) return fail(400, t('폴더가 없어요: {dir}', { dir }));
  const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
  return OK;
}

function openWindow() {
  const url = `http://${HOST}:${PORT}/`;
  if (process.platform === 'win32') {
    // 엣지의 '앱 모드'로 열면 주소창 없는 프로그램 창처럼 보인다
    const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
      .filter(Boolean)
      .map(dir => path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      .find(f => fs.existsSync(f));
    if (edge) spawn(edge, [`--app=${url}`, '--window-size=1320,860'], { detached: true, stdio: 'ignore' }).unref();
    else spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

// ───────────────────────── HTTP ─────────────────────────

const OK = [200, { ok: true }];
const fail = (status, error) => [status, { error }];

function sendJson(res, status, data) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 1e6) { reject(new Error(t('보낸 내용이 너무 커요'))); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function serveIndex(res) {
  fs.readFile(path.join(ROOT, 'index.html'), 'utf8', (err, html) => {
    if (err) return sendJson(res, 500, { error: t('index.html 을 읽지 못했어요') });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    // 화면에 열쇠·언어·사전을 심는다. 사전은 한국어가 아닐 때만 넣는다 (</script> 가 섞이지 않게 < 를 바꿔 쓴다)
    const dict = settings.lang === 'ko' ? 'null' : JSON.stringify(DICTS[settings.lang] || {}).replace(/</g, '\\u003c');
    res.end(html.replace('__AGENT_TOKEN__', TOKEN).replaceAll('__APP_LANG__', settings.lang).replace('/*__I18N__*/null', () => dict));
  });
}

function openStream(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 1500\n\n');
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function apiSend(b) {
  const text = cleanText(b.text);
  if (!text) return fail(400, t('보낼 내용이 비었어요'));
  let targets;
  if (b.target === 'all') targets = agents.slice();
  else if (Array.isArray(b.target)) targets = agents.filter(a => b.target.includes(a.id));
  else targets = [pickAgent()];
  if (!targets.length) return fail(400, t('보낼 에이전트를 골라 주세요'));
  for (const a of targets) enqueue(a, text);
  return [200, { ok: true, sentTo: targets.map(a => a.id) }];
}

function apiAdd() {
  if (agents.length >= MAX_AGENTS) return fail(400, t('에이전트는 최대 {n}명까지예요', { n: MAX_AGENTS }));
  const a = makeAgent();
  agents.push(a);
  sendAgents();
  save();
  return [200, { ok: true, id: a.id }];
}

// 모델·생각 깊이·속도·허락을 바꾼다. 빠른 모드는 Opus 에서만 되니, 켜면 Opus 로 바꾸고 다른 모델로 바꾸면 끈다 (claude 의 /fast 와 같은 규칙).
// AI(engine)는 Claude 또는 GPT(Codex). 빠른 모드는 Claude Opus 전용이라 GPT 로 바꾸면 꺼진다.
function applyRunOptions(t, b) {
  if (ENGINES.includes(b.engine)) t.engine = b.engine;
  if (typeof b.gptModel === 'string' && GPT_MODEL.test(b.gptModel)) t.gptModel = b.gptModel;
  if (MODELS.includes(b.model)) {
    t.model = b.model;
    if (b.model !== 'opus') t.fast = false;
  }
  if (EFFORTS.includes(b.effort)) t.effort = b.effort;
  if (typeof b.fast === 'boolean') {
    t.fast = b.fast;
    if (b.fast) { t.engine = 'claude'; t.model = 'opus'; }
  }
  if (t.engine === 'codex') t.fast = false;
  if (MODES.includes(b.permissionMode)) t.permissionMode = b.permissionMode;
}

// 실행 방식이 바뀌었으면 다음 일부터 새 claude 프로세스로 (일하는 중이면 그 일이 끝난 뒤에)
function restartIfChanged(a, before) {
  if (a.proc && Object.keys(before).some(k => a[k] !== before[k])) {
    if (a.current) a.dirty = true;
    else closeProc(a);
  }
}

// 새로 늘리는 에이전트의 기본값도 같은 규칙으로 바꾼다
function applyDefaults(b) {
  const d = {
    engine: settings.defaultEngine || 'claude', model: settings.defaultModel, gptModel: settings.defaultGptModel || '',
    effort: settings.defaultEffort, fast: !!settings.defaultFast, permissionMode: settings.defaultPermission,
  };
  applyRunOptions(d, b);
  Object.assign(settings, {
    defaultEngine: d.engine, defaultModel: d.model, defaultGptModel: d.gptModel,
    defaultEffort: d.effort, defaultFast: d.fast, defaultPermission: d.permissionMode,
  });
}

const fastWhy = reason => (!reason ? ''
  : /credit|extra_usage|overage|member_level/.test(reason) ? t(' — 유료 사용량 크레딧이 꺼져 있거나 바닥났어요')
    : /org/.test(reason) ? t(' — 조직 설정에서 막혀 있어요') : ` (${reason})`);

// 프롬프트 화면의 '모두에게': 모든 일꾼의 모델·생각 깊이·속도·허락을 한꺼번에 바꾸고, 새로 늘리는 에이전트도 같게 시작하게 한다
function apiApplyAll(b) {
  for (const a of agents) {
    const before = { engine: a.engine, model: a.model, gptModel: a.gptModel, effort: a.effort, fast: a.fast, permissionMode: a.permissionMode };
    applyRunOptions(a, b);
    restartIfChanged(a, before);
    sendAgent(a);
  }
  applyDefaults(b);
  broadcast({ type: 'settings', settings });
  save();
  return OK;
}

function apiUpdate(a, b) {
  const before = { cwd: a.cwd, engine: a.engine, model: a.model, gptModel: a.gptModel, effort: a.effort, fast: a.fast, permissionMode: a.permissionMode };
  if (typeof b.cwd === 'string' && b.cwd.trim()) {
    const dir = path.resolve(b.cwd.trim());
    if (!isDir(dir)) return fail(400, t('그 폴더가 없어요: {dir}', { dir }));
    a.cwd = dir;
  }
  if (typeof b.name === 'string' && b.name.trim()) a.name = b.name.trim().slice(0, 20);
  if (typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color)) a.color = b.color;
  if (typeof b.role === 'string') a.role = b.role.slice(0, 2000);
  applyRunOptions(a, b);
  if (a.cwd !== before.cwd) {
    // 대화 기록은 폴더별로 저장돼서 다른 폴더에서는 이어 할 수 없다
    a.sessionId = null;
    a.codexThread = null;
    addLog(a, { k: 'sys', text: t('작업 폴더를 바꿨어요 → {dir}\n폴더가 바뀌어서 다음 일은 새 대화로 시작해요', { dir: a.cwd }) });
  }
  restartIfChanged(a, before);
  sendAgent(a);
  save();
  return OK;
}

// 언어를 바꾸면: 기본 이름(감독관·클로드 N)을 새 언어로 바꾸고, claude 는 다음 일부터 새 언어 안내문으로 다시 띄우고,
// 이어 하는 GPT 대화에는 다음 글 앞에 새 언어를 알려 준다
function setLang(lang) {
  if (!LANGS.includes(lang) || lang === settings.lang) return;
  settings.lang = lang;
  supervisor.name = t('감독관');
  for (const a of agents) {
    const m = a.name.match(/^(?:클로드|Claude) (\d+)$/);
    if (m) a.name = t('클로드 {n}', { n: m[1] });
  }
  for (const a of allAgents()) {
    if (a.proc && a.proc.mode !== 'codex') { if (a.current) a.dirty = true; else closeProc(a); }
    if (a.codexThread) a.langNote = true;
  }
  sendAgents();
  sendAgent(supervisor);
}

// 저장 폴더를 옮긴다: 새 폴더에 지금 기록을 다 쓴 다음, 앱 폴더의 config.json 에 적고, 예전 폴더의 기록 파일을 지운다
function apiDataDir(b) {
  if (DATA_ARG) return fail(400, t('실행 옵션(--data)으로 저장 폴더가 정해져 있어서 여기서 바꿀 수 없어요'));
  const dir = path.resolve(String(b.dir || '').trim() || DEFAULT_DATA_DIR);
  if (dir === DATA_DIR) return OK;
  if (fs.existsSync(path.join(dir, 'state.json'))) return fail(400, t('그 폴더에는 이미 관제실 기록(state.json)이 있어요. 빈 폴더를 골라 주세요.'));
  if (!saveNow(dir)) return fail(400, t('그 폴더에 저장하지 못했어요: {dir}', { dir }));
  const config = readJson(CONFIG_FILE) || {};
  if (dir === DEFAULT_DATA_DIR) delete config.dataDir; else config.dataDir = dir;
  try {
    writeJson(CONFIG_FILE, config);
  } catch (e) {
    return fail(400, t('config.json 을 쓰지 못했어요: {why}', { why: e.message }));
  }
  const old = DATA_DIR;
  DATA_DIR = dir;
  for (const f of ['state.json', 'logs.json']) { try { fs.unlinkSync(path.join(old, f)); } catch { /* 없으면 그만 */ } }
  console.log(`[${clock()}] ${t('저장 폴더를 옮겼어요 → {dir}', { dir })}`);
  broadcast({ type: 'app', app: appInfo() });
  return OK;
}

// 처음 켤 때 고른 언어·작업 폴더·저장 폴더를 한 번에 적용한다
function apiSetup(b) {
  if (typeof b.dataDir === 'string' && b.dataDir.trim()) {
    const r = apiDataDir({ dir: b.dataDir });
    if (r[0] !== 200) return r;
  }
  if (typeof b.defaultCwd === 'string' && b.defaultCwd.trim()) {
    const dir = path.resolve(b.defaultCwd.trim());
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 아래에서 알려 준다 */ }
    if (!isDir(dir)) return fail(400, t('그 폴더를 만들 수 없어요: {dir}', { dir }));
    const before = settings.defaultCwd;
    settings.defaultCwd = dir;
    for (const a of agents) if (a.cwd === before && !a.current) a.cwd = dir;   // 처음 만든 에이전트들도 고른 폴더에서 일하게
  }
  setLang(b.lang);
  settings.setupDone = true;
  broadcast({ type: 'settings', settings });
  sendAgents();
  save();
  return OK;
}

function apiSettings(b) {
  if (typeof b.defaultCwd === 'string' && b.defaultCwd.trim()) {
    const dir = path.resolve(b.defaultCwd.trim());
    if (!isDir(dir)) return fail(400, t('그 폴더가 없어요: {dir}', { dir }));
    settings.defaultCwd = dir;
  }
  applyDefaults({
    engine: b.defaultEngine, model: b.defaultModel, gptModel: b.defaultGptModel,
    effort: b.defaultEffort, fast: b.defaultFast, permissionMode: b.defaultPermission,
  });
  setLang(b.lang);
  if (typeof b.sound === 'boolean') settings.sound = b.sound;
  if (typeof b.hoverMenu === 'boolean') settings.hoverMenu = b.hoverMenu;
  if (b.supervisor && typeof b.supervisor === 'object') {
    const s = b.supervisor;
    const sv = settings.supervisor;
    if (typeof s.enabled === 'boolean') sv.enabled = s.enabled;
    if (ENGINES.includes(s.engine)) sv.engine = s.engine;
    if (MODELS.includes(s.model)) sv.model = s.model;
    if (typeof s.gptModel === 'string' && GPT_MODEL.test(s.gptModel)) sv.gptModel = s.gptModel;
    if ([1, 2, 3].includes(Number(s.maxRounds))) sv.maxRounds = Number(s.maxRounds);
    if (!sv.enabled) supervisor.queue = [];   // 끄면 기다리던 검토는 버린다 (하던 검토는 끝까지 한다)
    sendAgent(supervisor);
  }
  const fbBefore = JSON.stringify([settings.fallbackEnabled, settings.fallbackUrl, settings.fallbackKey, settings.fallbackModels]);
  if (typeof b.fallbackUrl === 'string') {
    const url = b.fallbackUrl.trim() || DEFAULT_SETTINGS.fallbackUrl;
    if (!/^https?:\/\/\S+$/i.test(url)) return fail(400, t('게이트웨이 주소는 http:// 로 시작해야 해요'));
    settings.fallbackUrl = url.replace(/\/+$/, '');
  }
  if (typeof b.fallbackKey === 'string') settings.fallbackKey = b.fallbackKey.trim();
  if (Array.isArray(b.fallbackModels)) {
    settings.fallbackModels = [...new Set(b.fallbackModels.filter(m => typeof m === 'string').map(m => m.trim()).filter(Boolean))].slice(0, 10);
    for (const m of settings.fallbackModels) modelCooldown.delete(m);   // 순서를 새로 정했으면 쉬는 시간도 새로 시작
  }
  if (typeof b.fallbackEnabled === 'boolean') settings.fallbackEnabled = b.fallbackEnabled;
  if (JSON.stringify([settings.fallbackEnabled, settings.fallbackUrl, settings.fallbackKey, settings.fallbackModels]) !== fbBefore) {
    for (const a of allAgents()) if (a.mode === 'fallback' && a.proc) { if (a.current) a.dirty = true; else closeProc(a); }   // 새 주소·열쇠·모델로 다시 연결
    ensureCcr();
  }
  const pathChanged = typeof b.claudePath === 'string' && b.claudePath.trim() !== settings.claudePath;
  if (pathChanged) settings.claudePath = b.claudePath.trim();
  broadcast({ type: 'settings', settings });
  if (pathChanged) detectClaude();
  save();
  return OK;
}

async function route(method, p, b) {
  if (method === 'POST' && p === '/api/send') return apiSend(b);
  if (method === 'POST' && p === '/api/agents') return apiAdd();
  if (method === 'POST' && p === '/api/apply-all') return apiApplyAll(b);
  if (method === 'POST' && p === '/api/stop-all') { allAgents().forEach(stopAgent); return OK; }
  if (method === 'POST' && p === '/api/reset-all') { agents.forEach(resetAgent); return OK; }
  if (method === 'POST' && p === '/api/settings') return apiSettings(b);
  if (method === 'POST' && p === '/api/setup') return apiSetup(b);
  if (method === 'POST' && p === '/api/data-dir') return apiDataDir(b);
  if (method === 'POST' && p === '/api/open-data') return openFolder(DATA_DIR);
  if (method === 'POST' && p === '/api/auth/check') { checkAuth(); return OK; }
  if (method === 'POST' && p === '/api/auth/login') { const why = openLogin(); return why ? fail(400, why) : OK; }
  if (method === 'POST' && p === '/api/claude/detect') { detectClaude(); return OK; }
  if (method === 'POST' && p === '/api/codex/detect') { detectCodex(); return OK; }
  if (method === 'POST' && p === '/api/ccr/check') { await ensureCcr(); if (!settings.fallbackEnabled) await checkCcr(); return [200, { ccr }]; }
  if (method === 'POST' && p === '/api/ccr/open') { const why = await openCcrUi(); return why ? fail(400, why) : OK; }
  if (method === 'POST' && p === '/api/ccr/import-key') {
    const r = importCcrKey();
    if (r.error) return fail(400, r.error);
    for (const a of allAgents()) if (a.mode === 'fallback' && a.proc) { if (a.current) a.dirty = true; else closeProc(a); }   // 새 열쇠로 다시 연결
    broadcast({ type: 'settings', settings });
    save();
    await checkCcr();
    return [200, { ok: true, name: r.name, ccr }];
  }
  if (method === 'POST' && p === '/api/pick-folder') return [200, { path: await pickFolder(b.initial, b.purpose) }];
  if (method === 'DELETE' && p === '/api/history') { history = []; reports = []; broadcast({ type: 'history-clear' }); save(); return OK; }
  if (method === 'POST' && p === '/api/shutdown') { setTimeout(shutdown, 150); return OK; }

  const m = p.match(/^\/api\/agents\/([\w-]+)(?:\/([\w-]+))?(?:\/([\w-]+))?$/);
  if (!m) return fail(404, t('없는 주소예요'));
  const a = m[1] === 'supervisor' ? supervisor : agents.find(x => x.id === m[1]);
  if (!a) return fail(404, t('그 에이전트는 이제 없어요'));
  const act = m[2];
  // 감독관은 멈추기·새 대화만 된다 (설정은 설정 창에서, 일은 일꾼이 끝낸 뒤 저절로 받는다)
  if (a.isSupervisor && !(method === 'POST' && (act === 'stop' || act === 'reset'))) return fail(400, t('감독관은 멈추기만 할 수 있어요'));
  if (method === 'PATCH' && !act) return apiUpdate(a, b);
  if (method === 'DELETE' && !act) {
    if (agents.length <= MIN_AGENTS) return fail(400, t('에이전트는 최소 {n}명은 있어야 해요', { n: MIN_AGENTS }));
    removeAgent(a);
    return OK;
  }
  if (method === 'POST' && act === 'send') {
    const text = cleanText(b.text);
    if (!text) return fail(400, t('보낼 내용이 비었어요'));
    enqueue(a, text);
    return OK;
  }
  if (method === 'POST' && act === 'stop') { stopAgent(a); return OK; }
  if (method === 'POST' && act === 'reset') { resetAgent(a); return OK; }
  if (method === 'POST' && act === 'handover') return apiHandover(a, b);
  if (method === 'POST' && act === 'mode') {
    if (b.mode === 'fallback') {
      if (!fallbackReady()) return fail(400, t('설정 창에서 대체 AI 를 먼저 켜 주세요'));
      setMode(a, 'fallback', false, t('사용자가 대체 AI 로 바꿨어요'));
    } else if (b.mode === 'claude') {
      if (limit.hit) setLimit(null);   // 직접 Claude 로 돌린다는 건 한도가 풀렸다고 보는 것
      setMode(a, 'claude', false, t('사용자가 Claude 로 되돌렸어요'));
    } else return fail(400, t('claude 나 fallback 중에 골라 주세요'));
    return OK;
  }
  if (method === 'POST' && act === 'open') return openFolder(a.cwd);
  if (method === 'POST' && act === 'permission') {
    if (!['allow', 'always', 'deny'].includes(b.decision)) return fail(400, t('허락·계속 허락·거절 중에 골라 주세요'));
    return answerPermission(a, String(b.requestId), b.decision) ? OK : fail(404, t('이미 처리된 요청이에요'));
  }
  if (method === 'DELETE' && act === 'queue' && m[3]) {
    a.queue = a.queue.filter(q => q.id !== m[3]);
    sendAgent(a);
    return OK;
  }
  return fail(404, t('없는 주소예요'));
}

async function handle(req, res) {
  // DNS 리바인딩 공격 막기: 내 PC 주소로 들어온 요청만 받는다
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) return sendJson(res, 403, { error: t('허용되지 않은 주소예요') });
  const url = new URL(req.url, `http://${HOST}`);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveIndex(res);
  if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: t('없는 주소예요') });
  if ((req.headers['x-token'] || url.searchParams.get('token')) !== TOKEN) {
    return sendJson(res, 401, { error: t('화면을 새로 고침해 주세요 (열쇠가 맞지 않아요)') });
  }
  if (req.method === 'GET' && url.pathname === '/api/events') return openStream(req, res);
  const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : {};
  const [status, data] = await route(req.method, url.pathname, body);
  sendJson(res, status, data);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    sendJson(res, 500, { error: t('서버 오류: {why}', { why: e.message }) });
  });
});

// ───────────────────────── 켜기·끄기 ─────────────────────────

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log(t('끄는 중이에요…'));
  for (const a of allAgents()) {
    a.queue = [];
    if (a.proc) killProc(a);
  }
  if (ccrProc) forceKill(ccrProc);   // 관제실이 켠 CCR(과 게이트웨이)도 같이 끈다
  saveNow();
  broadcast({ type: 'bye' });
  for (const res of clients) res.end();
  server.close();
  setTimeout(() => process.exit(0), 800);
}

function banner() {
  const o = s => `\x1b[38;2;217;119;87m${s}\x1b[0m`;
  const dim = s => `\x1b[2m${s}\x1b[0m`;
  console.log([
    '',
    `   ${o(' ▐▛███▜▌')}    ${t('클로드 관제실')}`,
    `   ${o('▝▜█████▛▘')}   ${dim(`http://${HOST}:${PORT}/`)}`,
    `   ${o('  ▘▘ ▝▝')}     ${dim(t('이 검은 창을 닫으면 앱도 꺼져요'))}`,
    '',
  ].join('\n'));
}

loadState();
if (settings.defaultCwd === WORKDIR) fs.mkdirSync(WORKDIR, { recursive: true });

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(t('이미 켜져 있어요 (포트 {port}). 화면 창만 다시 열게요.', { port: PORT }));
    if (OPEN_WINDOW) openWindow();
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  banner();
  detectClaude();
  detectCodex();
  ensureCcr();
  console.log(claude.path ? t('claude 위치: {path}', { path: claude.path }) : t('claude 를 찾지 못했어요. 화면의 설정 창에서 위치를 알려 주세요.'));
  if (OPEN_WINDOW) openWindow();
});

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000).unref();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
