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

// ── 실행 옵션: node server.js [--port 7707] [--no-open] [--no-ccr] [--home 폴더] [--data 폴더] [--claude 경로] [--codex 경로] ──
const argv = process.argv.slice(2);
const argValue = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const PORT = Number(argValue('port')) || 7707;
const HOST = '127.0.0.1';
const ROOT = __dirname;
// 설정·기록·작업 폴더를 두는 곳. 기본은 앱 폴더이고, --home 을 주면 앱 폴더는 건드리지 않는다 (자동 시험, 여러 벌 따로 쓰기)
const HOME = path.resolve(argValue('home') || ROOT);
// 저장 폴더(설정·기록): 실행 옵션 --data > HOME 의 config.json 에 고른 폴더 > HOME 의 data
const CONFIG_FILE = path.join(HOME, 'config.json');
const DATA_ARG = argValue('data');
const DEFAULT_DATA_DIR = path.join(HOME, 'data');
let DATA_DIR = path.resolve(DATA_ARG || readJson(CONFIG_FILE)?.dataDir || DEFAULT_DATA_DIR);
const CLAUDE_ARG = argValue('claude');
const CODEX_ARG = argValue('codex');
const OPEN_WINDOW = !argv.includes('--no-open');
const MANAGE_CCR = !argv.includes('--no-ccr');   // 관제실이 CCR 을 직접 켜고 끌지. --no-ccr 이면 이미 켜져 있는 게이트웨이만 쓴다 (자동 시험, CCR 을 따로 돌리는 경우)
const WORKDIR = path.join(HOME, 'workspace');   // 처음 켤 때의 기본 작업 폴더 (전부터 쓰던 설치는 저장해 둔 '작업실'을 그대로 쓴다)

// 이 서버를 조종하는 열쇠. 관제실이 연 창에만 준다: 창은 한 번만 쓰는 번호(BOOT)가 붙은 주소로 들어와 쿠키를 받고,
// 쿠키가 있어야 열쇠가 든 화면을 받는다. 다른 웹사이트도, 이 PC 의 다른 프로그램(샌드박스 안의 GPT 도 이 PC 주소에는 접속할 수 있다)도
// 화면을 읽기만 해서는 열쇠를 얻지 못한다. API 는 쿠키가 아니라 열쇠 머리글(x-token)을 본다 — 쿠키는 포트를 가리지 않아 127.0.0.1 의 다른 포트 페이지에도 따라가기 때문
const TOKEN = crypto.randomBytes(16).toString('hex');
const COOKIE = `cr_session_${PORT}`;
const BOOT = new Map();                   // 창 열기 번호 → 쓸 수 있는 마지막 시각
const BOOT_TTL = 10 * 60_000;
const openRequest = () => path.join(DATA_DIR, 'open-window.req');   // 관제실을 또 켜면 이 쪽지를 남겨 이미 켜진 쪽이 새 창을 열게 한다 (샌드박스는 작업 폴더 밖에 못 써서 흉내 낼 수 없다)
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
// 일꾼 수(1~8명)에 들어가지 않는 관리하는 자리. 실행·기록은 일꾼과 같은 코드를 쓰고, id 가 곧 자리 이름이다.
const STAFF_KEYS = ['supervisor', 'lead', 'security', 'tester'];
const STAFF_NAME = { supervisor: '감독관', lead: '팀장', security: '보안 검사관', tester: '테스터' };
const STAFF_COLOR = { supervisor: '#FFD23F', lead: '#B58CFF', security: '#6AA9FF', tester: '#5FD08A' };
const REVIEW_STAGES = ['supervisor', 'security', 'tester'];   // 일꾼이 끝낸 일을 이 차례로 검사한다 (꺼진 자리는 건너뛴다)
const REPORT_DONE = ['pass', 'left', 'stopped'];
const PLAN_KEEP = 30;                     // 팀장 계획 수
const PLAN_LIVE = ['planning', 'proposed', 'running', 'reporting'];   // 아직 끝나지 않은 계획
const TASK_DONE = ['done', 'left', 'error', 'stopped'];               // 끝난 계획 조각

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
  notify: false,       // 창을 안 보고 있을 때 바탕화면 알림 (브라우저 허락이 필요해서 기본은 끔)
  effects: true,       // 화려한 효과 (배경·색종이·빛나는 테두리)
  hoverMenu: true,
  // 감독관: 일꾼이 끝낸 일(파일을 고쳤거나 명령을 돌린 일)을 읽기 도구만으로 검토하고, 고칠 점은 그 일꾼에게 다시 시킨다
  supervisor: { enabled: true, engine: 'claude', model: 'sonnet', gptModel: '', maxRounds: 2 },   // engine 'codex' = GPT 가 검사
  // 새 자리는 쓸 때마다 AI 사용량이 들어서 처음엔 꺼 둔다
  lead: { enabled: false, engine: 'claude', model: 'sonnet', gptModel: '', approve: true },   // 팀장: 큰 일을 나눠 맡긴다 (approve = 계획을 먼저 보여 주고 허락받기)
  security: { enabled: false, engine: 'claude', model: 'sonnet', gptModel: '' },             // 보안 검사관: 읽기만 하며 보안 문제를 찾는다
  tester: { enabled: false, engine: 'claude', model: 'sonnet', gptModel: '' },               // 테스터: 명령을 실제로 돌려 본다 (Claude 는 명령마다 허락을 받는다)
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
let staff = {};          // 관리하는 자리 (감독관·팀장·보안 검사관·테스터, loadState 에서 만든다)
let supervisor = null;   // = staff.supervisor
let history = [];
let reports = [];   // 검사 보고: 검사한 일 하나에 카드 하나. 고치게 했다가 다시 보는 동안에도 같은 카드를 이어서 고친다
let plans = [];     // 팀장 계획: 큰 일 하나에 계획 하나 (조각마다 맡은 일꾼과 진행 상태)
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
    failedCarry: saved.failedCarry || null,   // 오류로 끝난 마지막 일의 감독관 검토 정보 (⇄ 로 넘길 때 같은 보고 카드로 잇는다)
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
  for (const k of STAFF_KEYS) settings[k] = { ...DEFAULT_SETTINGS[k], ...(saved.settings?.[k] || {}) };
  history = Array.isArray(saved.history) ? saved.history.slice(0, HISTORY_KEEP) : [];
  reports = Array.isArray(saved.reports) ? saved.reports.slice(0, REPORT_KEEP) : [];
  for (const r of reports) {   // 앱을 끄면 기다리던 검토·고치기도 사라진다
    if (REPORT_LIVE.includes(r.state)) Object.assign(r, { state: 'stopped', note: t('앱을 다시 켜서 검토가 끊겼어요') });
  }
  plans = Array.isArray(saved.plans) ? saved.plans.slice(0, PLAN_KEEP) : [];
  for (const p of plans) {
    if (!PLAN_LIVE.includes(p.state)) continue;
    p.state = 'stopped';
    p.note = t('앱을 다시 켜서 계획이 끊겼어요');
    for (const x of p.tasks) if (!TASK_DONE.includes(x.state)) x.state = 'stopped';
  }
  agents = [];
  const list = Array.isArray(saved.agents) ? saved.agents.slice(0, MAX_AGENTS) : [];
  for (const s of list) agents.push(makeAgent(s, logs[s.id]));
  const want = list.length ? MIN_AGENTS : 4;   // 처음 켤 때는 4명으로 시작
  while (agents.length < want) agents.push(makeAgent());
  // 관리하는 자리는 일꾼 수(1~8명)에 들어가지 않는 따로 된 에이전트다. 실행·기록 방식은 일꾼과 같은 코드를 쓴다.
  staff = {};
  for (const k of STAFF_KEYS) {
    const kept = saved.staff?.[k] || (k === 'supervisor' ? saved.supervisor : null) || {};   // 예전 기록은 감독관만 따로 저장했다
    const s = makeAgent({ ...kept, id: k, name: t(STAFF_NAME[k]), color: STAFF_COLOR[k], cwd: settings.defaultCwd }, logs[k]);
    s.staff = k;
    s.permissionMode = k === 'tester' ? 'manual' : 'dontAsk';   // 테스터만 명령을 쓰고, 그때마다 사용자에게 묻는다
    s.fast = false;
    s.model = settings[k].model;
    staff[k] = s;
  }
  supervisor = staff.supervisor;
}

const staffList = () => STAFF_KEYS.map(k => staff[k]).filter(Boolean);
const allAgents = () => [...agents, ...staffList()];

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
        engine: a.engine, gptModel: a.gptModel, codexThread: a.codexThread, lastAi: a.lastAi, failedCarry: a.failedCarry || undefined,
        permissionMode: a.permissionMode, sessionId: a.sessionId, last: a.last, stats: a.stats,
        mode: a.mode, autoMode: a.autoMode, fbSessionId: a.fbSessionId, fbModel: a.fbModel,
      })),
      history,
      reports,
      plans,
      staff: Object.fromEntries(staffList().map(s => [s.staff, { stats: s.stats, last: s.last, mode: s.mode, autoMode: s.autoMode, fbModel: s.fbModel }])),
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
    id: a.id, name: a.name, color: a.color, role: a.role, cwd: a.cwd, staff: a.staff || null, isSupervisor: a.staff === 'supervisor',
    model: a.model, effort: a.effort, fast: !!a.fast, fastState: a.fastState || null, permissionMode: a.permissionMode,
    engine: a.engine, gptModel: a.gptModel, lastAi: a.lastAi,
    sessionId: a.sessionId, runtimeModel: a.runtimeModel, stats: a.stats, mode: a.mode, autoMode: a.autoMode, fbModel: a.fbModel,
    status: a.status, last: a.last, activity: a.activity, running: !!a.proc,
    current: a.current && {
      prompt: a.current.prompt, startedAt: a.current.startedAt, stopping: !!a.current.stopping,
      reviewing: a.current.review?.workerName || null,   // 검사하는 자리가 지금 보는 일꾼
      phase: a.current.plan?.phase || null,              // 팀장: 'plan' 계획 세우기 / 'report' 결과 모으기
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
  broadcast({ type: a.staff ? 'staff' : 'agent', agent: pub(a) });
}

function sendAgents() {
  scheduleSweep();
  broadcast({ type: 'agents', agents: agents.map(pub) });
}

const APP_VERSION = readJson(path.join(ROOT, 'package.json'))?.version || '';
const appInfo = () => ({ url: `http://${HOST}:${PORT}/`, version: APP_VERSION, dataDir: DATA_DIR, dataFixed: !!DATA_ARG, defaultDataDir: DEFAULT_DATA_DIR });

// 문제를 알릴 때 붙이는 진단 정보. 열쇠와 시킨 일(프롬프트)·AI 가 한 말은 넣지 않고, 사용자 이름이 든 홈 폴더 경로는 ~ 로 가린다.
function diagnostics() {
  const tidy = v => String(v ?? '').split(os.homedir()).join('~');
  const { fallbackKey, claudePath, defaultCwd, ...rest } = settings;
  const recent = allAgents()
    .flatMap(a => a.log.filter(e => e.k === 'err' || (e.k === 'done' && e.status === 'error')).map(e => ({ t: e.t, agent: a.name, text: tidy(e.text).slice(0, 400) })))
    .sort((x, y) => y.t - x.t).slice(0, 20)
    .map(e => ({ ...e, t: new Date(e.t).toISOString() }));
  return {
    app: { name: 'claude-control-room', version: APP_VERSION, lang: settings.lang },
    node: process.version,
    os: `${process.platform} ${os.release()} ${process.arch}`,
    claude: { found: !!claude.path, version: claude.version, loggedIn: auth.loggedIn, method: auth.method },
    codex: { found: !!codex.path, version: codex.version, loggedIn: codex.loggedIn, models: codex.models.length },
    ccr: { managed: MANAGE_CCR, running: !!(ccrProc && !ccrProc.ended), ok: ccr.ok, error: ccr.error, models: ccr.models.length },
    limit,
    settings: { ...rest, fallbackKey: fallbackKey ? '(set)' : '', claudePath: tidy(claudePath), defaultCwd: tidy(defaultCwd) },
    agents: allAgents().map(a => ({
      name: a.name, engine: a.engine, model: a.model, gptModel: a.gptModel, effort: a.effort, fast: !!a.fast, permissionMode: a.permissionMode,
      mode: a.mode, status: a.status, last: a.last, runs: a.stats.runs, queued: a.queue.length, cwd: tidy(a.cwd),
    })),
    recentErrors: recent,
  };
}

function snapshot() {
  return {
    type: 'snapshot',
    settings,
    agents: agents.map(pub),
    supervisor: pub(supervisor),
    staff: Object.fromEntries(staffList().map(s => [s.staff, pub(s)])),
    logs: Object.fromEntries(allAgents().map(a => [a.id, a.log])),
    history,
    reports,
    plans,
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
// 관리하는 자리는 읽기만 하고, 테스터만 시험을 돌리느라 작업 폴더 안에 쓸 수 있다
const codexSandbox = a => (a.staff ? (a.staff === 'tester' ? 'workspace-write' : 'read-only')
  : a.permissionMode === 'plan' || a.permissionMode === 'manual' ? 'read-only' : 'workspace-write');

function codexArgs(a, resume) {
  const opts = ['--json', '--ignore-user-config', '--skip-git-repo-check'];
  // 첨부한 사진: --image=경로 로 하나씩 넘긴다 (--image 는 값을 여럿 받아서, 띄어 쓰면 마지막 '-'(글은 stdin)까지 사진으로 먹는다)
  for (const img of a.current?.images || []) if (fs.existsSync(img)) opts.push(`--image=${img}`);
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
  const resume = !!a.codexThread && !a.staff;
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
      if (!a.staff && ev.thread_id && a.codexThread !== ev.thread_id) { a.codexThread = ev.thread_id; save(); }
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
        const text = a.staff ? stripVerdict(item.text) : item.text.trim();
        if (text) addLog(a, { k: 'text', text });
      } else if (item.type === 'command_execution') {
        const failed = item.exit_code != null && item.exit_code !== 0;
        const out = summarizeResult('Bash', item.aggregated_output || '', failed);
        if (out) addLog(a, { k: 'out', text: out, err: failed });
        // GPT 가 파일 편집 대신 명령(Set-Content 등)으로 파일을 바꿨으면 그것도 감독관 검토 자료에 넣는다
        const c = cleanCmd(item.command);
        if (!failed && !a.staff && WRITE_CMD.test(c)) trackWork(a, cur, { name: 'Bash', input: { command: c } });
      } else if (item.type === 'file_change' && Array.isArray(item.changes)) {
        // GPT 는 파일을 읽을 때도 명령을 쓰니, 감독관 검토 자료로는 실제로 고친 파일만 모은다
        for (const c of item.changes) {
          const name = c.kind === 'add' ? 'Write' : 'Edit';
          addLog(a, { k: 'tool', name, summary: shortPath(c.path) });
          if (!a.staff) trackWork(a, cur, { name, input: { file_path: c.path } });
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
    else if (!cur.retried && a.codexThread && !a.staff && /no (?:rollout|session|conversation|thread)|not found/i.test(tail)) {
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

// 자리마다 붙이는 안내문 (GPT 에게는 첫 글 앞에 붙인다)
function staffNote(k, gpt) {
  if (k === 'supervisor') return supervisorNote(gpt);
  const readOnly = gpt ? t('파일을 직접 열어 확인하세요. 읽기 전용이라 파일을 고칠 수는 없습니다.')
    : t('읽기 도구(Read, Glob, Grep)로 파일을 직접 열어 확인하세요. 파일을 고치거나 명령을 실행할 수는 없습니다.');
  const verdictLine = t('설명은 한국어로 짧게 하고, 마지막 줄에는 요청받은 형식의 JSON 한 줄로 판정을 적으세요.');
  if (k === 'security') {
    return [t(`당신은 '클로드 관제실'의 보안 검사관입니다. 다른 에이전트(일꾼)가 끝낸 일에서 보안 문제만 찾습니다.`), readOnly,
      t('실제로 위험한 것만 문제로 삼으세요. 기능이나 꾸밈, 확인하지 못한 것만으로는 fix 로 판정하지 마세요.'), verdictLine].join('\n');
  }
  if (k === 'tester') {
    return [t(`당신은 '클로드 관제실'의 테스터입니다. 다른 에이전트(일꾼)가 끝낸 일이 실제로 돌아가는지 직접 실행해서 확인합니다.`),
      gpt ? t('작업 폴더 안에서 명령을 실행할 수 있어요. 파일은 고치지 마세요.') : t('명령을 실행할 때마다 사용자에게 허락을 받아요. 꼭 필요한 명령만 쓰고, 파일은 고치지 마세요.'),
      t('계속 켜져 있는 서버나 창은 띄우지 마세요. 확인하지 못한 것만으로는 fix 로 판정하지 말고 summary 에 적으세요.'), verdictLine].join('\n');
  }
  return [t(`당신은 '클로드 관제실'의 팀장입니다. 사용자의 큰 일을 일꾼들에게 나눠 맡기고, 끝나면 결과를 모아 사용자에게 보고합니다.`), readOnly,
    t('직접 일하지 말고, 요청받은 형식으로 답하세요. 설명은 한국어로 짧게 하세요.')].join('\n');
}

function write(proc, obj) {
  if (proc && !proc.ended && proc.stdin.writable) proc.stdin.write(JSON.stringify(obj) + '\n');
}

function startProc(a) {
  // --permission-prompt-tool stdio 가 있어야 허락이 필요한 일을 claude 가 혼자 거절하지 않고 이 서버(화면)에 물어본다
  // 관리하는 자리는 읽기 도구 3개만 갖고, 그 밖의 일은 묻지 않고 거절된다 (dontAsk) — 일꾼의 파일을 건드릴 수 없다.
  // 테스터만 명령 도구를 더 갖고, 명령마다 사용자에게 묻는다 (manual + stdio)
  const tester = a.staff === 'tester';
  const args = a.staff ? [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...(tester ? ['--permission-mode', 'manual', '--permission-prompt-tool', 'stdio'] : ['--permission-mode', 'dontAsk']),
    '--tools', tester ? `Read,Glob,Grep,Bash${process.platform === 'win32' ? ',PowerShell' : ''}` : 'Read,Glob,Grep',
    // --tools 로 도구를 줄이면 MCP 도구를 필요할 때만 불러오는 기능(ToolSearch)도 빠져서, PC 에 깔린 MCP 도구 설명이 통째로 대화에 실린다
    // (2026-11-19 진짜 Sonnet 으로 재 보니 검토 한 번에 60만 토큰 → 이 두 옵션을 붙이면 2만 7천 토큰). 관리하는 자리는 MCP 도구·스킬이 필요 없다
    '--strict-mcp-config', '--disable-slash-commands',
    '--name', t('관제실 · {name}', { name: a.name }), '--append-system-prompt', staffNote(a.staff, false),
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
    if (a.fast && !a.staff) args.push('--settings', JSON.stringify({ fastMode: true }));   // -p 에서는 이렇게만 빠른 모드를 켤 수 있다
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
          const text = a.staff ? stripVerdict(b.text) : b.text.trim();   // 감독관의 판정 JSON 줄은 보고 카드로 따로 보여 준다
          if (text) addLog(a, { k: 'text', text });
        } else if (b.type === 'tool_use') {
          const summary = summarizeTool(b.name, b.input);
          a.tools.set(b.id, b.name);
          addLog(a, { k: 'tool', name: b.name, summary: summary.slice(0, 1500), sub });
          if (!sub) setActivity(a, `${toolKo(b.name)} ${firstLine(summary).slice(0, 60)}`.trim());
          if (cur && !a.staff) trackWork(a, cur, b);
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
  if (!a.staff) {   // 감독관의 검토는 기록 창에 따로 남기지 않고, 검토받은 일의 기록에 판정을 붙인다
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
  if (a.staff) {
    if (cur.review) finishReview(a, cur.review, status, text);
    else if (cur.plan) finishLead(cur.plan, status, text);
    return;
  }
  const pt = cur.planTask;
  if (pt) planTaskPatch(pt, { result: String(text || '').slice(0, 3000) });
  if (status === 'done') {
    const reviewing = requestReview(a, cur, text);
    if (pt) { if (reviewing) planTaskPatch(pt, { state: 'reviewing' }); else planTaskEnd(pt, 'done'); }
  } else if (!cur.handover) {   // 다른 AI 에게 넘긴 일은 보고 카드·계획 조각을 그대로 이어 간다
    if (cur.reportId) markReport(cur.reportId, { state: 'stopped', note: status === 'stopped' ? t('일꾼을 멈춰서 고치기를 그만뒀어요') : t('일꾼이 고치다가 오류가 났어요') });
    if (pt) planTaskEnd(pt, status === 'stopped' ? 'stopped' : 'error');
  }
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
  // 관리하는 자리는 일마다 새 대화로 시작한다 (일끼리 섞이지 않게). 검사는 그 일꾼의 폴더에서, 팀장은 기본 작업 폴더에서 한다
  if (a.staff && (a.queue[0].review || a.queue[0].plan)) {
    const cfg = settings[a.staff];
    a.cwd = a.queue[0].review ? a.queue[0].review.cwd : settings.defaultCwd;
    a.engine = cfg.engine === 'codex' ? 'codex' : 'claude';
    a.model = cfg.model;
    a.gptModel = cfg.gptModel || '';
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
    review: item.review,                 // 검사하는 자리: 지금 검사하는 일
    plan: item.plan,                     // 팀장: 지금 다루는 계획과 단계
    planTask: item.planTask,             // 일꾼: 팀장이 나눈 일이면 그 계획 조각
    round: item.round || 0,              // 일꾼: 감독관이 몇 번째로 고치게 한 일인지
    task: item.task || item.text,        // 일꾼: 처음 시킨 일 (고치기를 여러 번 해도 그대로)
    reportId: item.reportId,             // 일꾼: 감독관이 고치라고 한 일이면 그 보고 카드
    files: item.files ? new Set(item.files) : undefined,   // 넘겨받은 일이면 앞 AI 가 고친 파일부터
    commands: item.commands ? [...item.commands] : undefined,
    images: item.images,                 // GPT 에게 같이 넘길 사진 (첨부)
  };
  if (item.review?.reportId) markReport(item.review.reportId, { state: 'reviewing', stage: a.staff });
  if (item.planTask) planTaskPatch(item.planTask, { state: item.round ? 'fixing' : 'working' });
  // 인수인계 쪽지: 지난 일과 다른 AI(Claude ↔ 대체 AI ↔ GPT)가 맡으면, 새 AI 에게 지난 일을 먼저 알려 준다
  const ai = aiOf(a, useCodex);
  const fresh = !a.staff && a.lastAi && a.lastAi !== ai ? handoffNote(a, a.lastAi, ai, item.takeover) : '';
  const note = fresh || item.note || '';   // 같은 AI 가 같은 일을 새 대화로 다시 하면 처음 건넨 쪽지를 다시 건넨다
  a.current.note = note;
  if (!item.quiet) addLog(a, { k: 'user', text: item.text });
  if (fresh) addLog(a, { k: 'sys', text: t('인수인계 쪽지를 건넸어요 ({from} → {to})', { from: aiKo(a.lastAi), to: aiKo(ai) }) });
  else if (note) addLog(a, { k: 'sys', text: t('새 대화로 다시 해서 인수인계 쪽지를 다시 건넸어요') });
  if (!a.staff && a.lastAi !== ai) { a.lastAi = ai; save(); }
  let text = note + item.text;
  if (useCodex) {
    // Codex 에는 붙일 시스템 안내 칸이 없어서, 새 대화의 첫 글 앞에 같은 안내를 붙인다
    // 어느 폴더에서 일하는지 전체 경로로 알려 준다 (그 밖에는 샌드박스가 쓰기를 막는다)
    let where = t('작업 폴더: {dir} (파일은 이 폴더 안에서만 만들고 고칠 수 있어요)', { dir: a.cwd });
    // 윈도의 읽기 전용 샌드박스에서는 PowerShell 이 제한 모드라 Get-Content 출력의 한글이 깨진다 (파일은 멀쩡하다).
    // cmd /c type 이나 node 로 읽으면 바이트가 그대로 나온다 (2026-11-20 진짜 Codex 로 확인). 모르면 멀쩡한 파일을 '깨졌다'며 고치게 한다
    if (process.platform === 'win32' && codexSandbox(a) === 'read-only') {
      where += `\n${t('이 PC의 읽기 전용 환경에서는 PowerShell 의 Get-Content 출력에서 한글이 깨져 보여요. 파일 내용은 cmd /c type 파일이름 으로 읽으세요. 그래도 한글이 깨져 보이면 파일이 아니라 출력 문제이니, 그것만으로 파일을 고치게 하지 마세요.')}`;
    }
    if (a.staff) text = `${staffNote(a.staff, true)}\n${where}\n\n${text}`;
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
  round: cur.round, task: cur.task, review: cur.review, reportId: cur.reportId, plan: cur.plan, planTask: cur.planTask,
  files: cur.files ? [...cur.files] : undefined, commands: cur.commands ? [...cur.commands] : undefined,   // 앞 AI 가 이미 고친 것도 감독관이 보게
  note: cur.note,   // 이어 할 대화를 잃거나 대체 AI 모델이 바뀌어 새 대화로 다시 해도 인수인계 쪽지를 잃지 않게
  images: cur.images,   // 첨부한 사진도 같이 다시 넘긴다
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
  if (MANAGE_CCR && process.platform === 'win32' && !(ccrProc && !ccrProc.ended)) await startCcr();
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
  if (process.platform !== 'win32' || !MANAGE_CCR) return t('터미널에서 ccr ui 를 실행해 주세요.');
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
  // 팀장이 나눈 일이면 검사가 끝난 때가 그 조각이 끝난 때다
  if (r.planTask && REPORT_DONE.includes(r.state)) planTaskEnd(r.planTask, { pass: 'done', left: 'left' }[r.state] || 'stopped', r.work || r.summary || r.note || '');
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
    // 계획도 같다: 하던 조각을 아무도 들고 있지 않거나(대기열을 비움·일꾼을 지움), 팀장 차례인데 팀장이 들고 있지 않으면 멈춘 것으로 닫는다
    const holdsTask = (item, id) => !!item && (item.planTask?.taskId === id || item.review?.planTask?.taskId === id);
    const holdsPlan = (item, id) => !!item && item.plan?.planId === id;
    for (const p of plans) {
      if (p.state === 'planning' || p.state === 'reporting') {
        const lead = staff.lead;
        if (!holdsPlan(lead.current, p.id) && !lead.queue.some(q => holdsPlan(q, p.id))) markPlan(p.id, { state: 'stopped', note: t('팀장이 하던 일이 멈췄어요') });
        continue;
      }
      if (p.state !== 'running') continue;
      for (const x of p.tasks) {
        if (TASK_DONE.includes(x.state) || x.state === 'blocked') continue;   // 앞 조각을 기다리는 조각은 아직 아무도 들고 있지 않다
        const held = allAgents().some(a => holdsTask(a.current, x.id) || a.queue.some(q => holdsTask(q, x.id)))
          || reports.some(r => REPORT_LIVE.includes(r.state) && r.planTask?.taskId === x.id);
        if (!held) planTaskEnd({ planId: p.id, taskId: x.id }, 'stopped');
      }
    }
  });
}

// 검사 자리·팀장 답에서 판정·계획 JSON 줄을 뺀 설명만 남긴다 (```json 으로 감싼 경우도)
function stripVerdict(text) {
  return String(text || '').split('\n').filter(l => !/^\s*\{.*"(?:verdict|tasks)"/.test(l)).join('\n')
    .replace(/```[a-z]*\s*```/gi, '').trim();
}

// 보고 카드에는 작업 폴더 안의 파일을 짧게 적는다
function relFile(cwd, file) {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : shortPath(file);
}

// ── 검사 팀: 일꾼이 끝낸 일을 감독관 → 보안 검사관 → 테스터 차례로 검사한다 (켜진 자리만) ──

const staffName = k => t(STAFF_NAME[k] || k);
const stageOn = k => !!settings[k]?.enabled && !!staff[k];
// after 다음 차례의 켜진 검사 자리 (after 가 없으면 첫 자리). 없으면 null
const nextStage = after => REVIEW_STAGES.slice(after ? REVIEW_STAGES.indexOf(after) + 1 : 0).find(stageOn) || null;

// 일꾼이 일을 끝내면 첫 검사 자리에 맡긴다. 파일도 안 고치고 명령도 안 돌린 일(질문·답)은 건너뛴다. 맡겼으면 true
function requestReview(a, cur, text) {
  const files = [...(cur.files || [])];
  const commands = cur.commands || [];
  let r = cur.reportId && reports.find(x => x.id === cur.reportId);
  const stage = nextStage(null);
  if (!stage) {
    if (r) markReport(r.id, { state: 'stopped', note: t('검사하는 자리를 모두 꺼서 고친 뒤 다시 보지 않았어요') });
    return false;
  }
  if (!files.length && !commands.length && !r) return false;   // 검사 자리가 고치라고 한 일은 바뀐 게 없어도 다시 본다
  const round = cur.round || 0;
  if (!r) {
    r = { id: newId(), workerId: a.id, workerName: a.name, color: a.color, task: String(cur.task || '').slice(0, 300),
      work: '', summary: '', fix: '', note: '', files: [], steps: [], at: Date.now(), planTask: cur.planTask || null };
    reports.unshift(r);
    if (reports.length > REPORT_KEEP) reports.length = REPORT_KEEP;
  }
  markReport(r.id, {
    state: 'queued', stage, round, max: settings.supervisor.maxRounds, note: '',
    files: [...new Set([...r.files, ...files.map(f => relFile(a.cwd, f))])].slice(0, 12),
  });
  const review = {
    workerId: a.id, workerName: a.name, cwd: a.cwd, round, task: cur.task, prompt: cur.prompt, historyId: cur.historyId, reportId: r.id,
    files, commands, text: String(text || '').slice(0, 4000), planTask: cur.planTask || null,
  };
  queueReview(stage, review);
  addLog(a, { k: 'sys', text: t('{name}에게 검사를 맡겼어요', { name: staffName(stage) }) + (round ? ` ${t('({n}번째 수정 뒤)', { n: round })}` : '') });
  return true;
}

function queueReview(stage, review) {
  const s = staff[stage];
  s.queue.push({ id: newId(), text: reviewPrompt(stage, review), quiet: true, review: { ...review, stage } });
  const after = review.round ? ` ${t('({n}번째 수정 뒤)', { n: review.round })}` : '';
  addLog(s, { k: 'user', text: `${t('{name} 검토', { name: review.workerName })}${after} — ${firstLine(review.task).slice(0, 80)}` });
  sendAgent(s);
  pump(s);
}

// 검사 자리에 보내는 글: 일꾼이 한 일(공통) + 자리마다 볼 것 + 판정 JSON 형식
function reviewPrompt(stage, rv) {
  const none = t('- (없음)');
  const ga = josa(rv.workerName, '이', '가');
  const head = {
    supervisor: t('[검토 요청] 일꾼 "{name}"{ga} 일을 끝냈어요. 지금 폴더가 그 일꾼의 작업 폴더예요.', { name: rv.workerName, ga }),
    security: t('[보안 검사 요청] 일꾼 "{name}"{ga} 일을 끝냈어요. 지금 폴더가 그 일꾼의 작업 폴더예요.', { name: rv.workerName, ga }),
    tester: t('[시험 요청] 일꾼 "{name}"{ga} 일을 끝냈어요. 지금 폴더가 그 일꾼의 작업 폴더예요.', { name: rv.workerName, ga }),
  }[stage];
  const ask = {
    supervisor: [t('위 파일을 직접 읽어서 시킨 일을 제대로 했는지, 버그·빠뜨린 것·위험한 점이 있는지 확인하세요.')],
    security: [
      t('위 파일을 직접 읽어서 보안 문제만 찾으세요: 코드에 적힌 열쇠·비밀번호·토큰, 사용자 몰래 바깥으로 보내는 정보, 위험한 명령(지우기·시스템 설정 바꾸기), 검사 없이 실행하거나 화면에 넣는 입력(eval, innerHTML, 이어 붙인 SQL 문장).'),
      t('기능이나 꾸밈은 보지 마세요. 실제로 위험한 것만 fix 로 판정하세요.'),
    ],
    tester: [
      t('이 일이 실제로 돌아가는지 직접 실행해서 확인하세요. 시험(test)이 있으면 돌리고, 없으면 문법 검사나 짧게 실행해 보는 정도로 확인하세요.'),
      t('파일은 고치지 마세요. 실행해 보니 깨지는 것만 fix 로 판정하세요.'),
    ],
  }[stage];
  return [
    head,
    '', t('## 사용자가 시킨 일'), rv.task,
    ...(rv.round ? ['', t('## 이번은 검사하는 자리가 고치게 한 {n}번째 수정이에요. 이번에 시킨 내용', { n: rv.round }), rv.prompt] : []),
    '', t('## 일꾼이 만들거나 고친 파일'), ...(rv.files.length ? rv.files.map(f => `- ${f}`) : [none]),
    '', t('## 일꾼이 실행한 명령'), ...(rv.commands.length ? rv.commands.map(c => `- ${c}`) : [none]),
    '', t('## 일꾼의 마지막 보고'), rv.text || t('(없음)'),
    '', ...ask,
    t('짧게 설명한 뒤 마지막 줄에 아래 형식의 JSON 한 줄만 적으세요.'),
    t('{"verdict":"pass","work":"일꾼이 한 일","summary":"판정 한 문장","fix":""}'),
    t('work 에는 일꾼이 실제로 만들거나 고친 것과 그 결과를 사용자에게 보고하듯 1~2문장으로 적으세요. 관제실 보고판에 그대로 올라가요.'),
    t('summary 에는 판정 이유를 한 문장으로 적으세요.'),
    t('고칠 게 있으면 verdict 를 "fix" 로 하고, fix 에 일꾼에게 그대로 전할 구체적인 수정 지시를 적으세요.'),
  ].join('\n');
}

// 검사 자리 답의 마지막 JSON 한 줄에서 판정을 읽는다
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

function finishReview(s, review, status, text) {
  const worker = agents.find(x => x.id === review.workerId);
  const rid = review.reportId;
  const who = s.name;
  if (!worker) {
    if (rid) markReport(rid, { state: 'stopped', note: t('검토하는 동안 일꾼이 지워졌어요') });
    return;
  }
  if (status !== 'done') {
    addLog(worker, { k: 'sys', text: t('{name} 검사가 끝나지 못했어요 ({status})', { name: who, status: statusKo(status) }) });
    if (rid) markReport(rid, { state: 'stopped', note: status === 'stopped' ? t('{name} 검사를 멈췄어요', { name: who }) : t('{name}{ga} 검사하다가 오류가 났어요', { name: who, ga: josa(who, '이', '가') }) });
    return;
  }
  const v = parseVerdict(text);
  if (!v) {
    addLog(worker, { k: 'sys', text: t('{name}의 판정을 읽지 못했어요 — {name} 칸에서 내용을 확인해 주세요', { name: who }) });
    if (rid) markReport(rid, { state: 'stopped', note: t('{name}의 판정을 읽지 못했어요 — {name} 칸에서 내용을 확인해 주세요', { name: who }) });
    return;
  }
  const h = history.find(x => x.id === review.historyId);
  if (h) {
    h.review = { verdict: v.verdict, work: v.work || h.review?.work || '', summary: v.summary, round: review.round, stage: review.stage };
    broadcast({ type: 'history-update', item: h });
    save();
  }
  // 보고 카드: 한 일(work)은 가장 최근에 받은 것으로, 판정은 차례(steps)로 쌓는다
  const r = rid && reports.find(x => x.id === rid);
  const report = patch => {
    if (!r) return;
    const steps = [...(r.steps || []), { stage: review.stage, round: review.round, verdict: v.verdict, summary: v.summary }].slice(-10);
    markReport(rid, { work: v.work || r.work, summary: v.summary, fix: v.fix, steps, note: '', ...patch });
  };
  console.log(`[${clock()}] ${who}: ${worker.name} ${v.verdict === 'pass' ? t('통과') : t('수정 요청')} — ${v.summary.slice(0, 60)}`);
  if (v.verdict === 'pass') {
    addLog(worker, { k: 'sys', text: t('✓ {name} 통과 — {summary}', { name: who, summary: v.summary }) });
    addLog(s, { k: 'sys', text: t('판정: {name} 통과 — {summary}', { name: worker.name, summary: v.summary }) });
    const next = nextStage(review.stage);
    if (next) {
      report({ state: 'queued', stage: next });
      queueReview(next, review);
      addLog(worker, { k: 'sys', text: t('{name}에게 검사를 맡겼어요', { name: staffName(next) }) });
    } else report({ state: 'pass' });
    return;
  }
  const max = settings.supervisor.maxRounds;
  if (review.round >= max) {
    addLog(worker, { k: 'sys', text: t('⚠ 검사하는 자리가 {max}번 고치게 했는데도 문제가 남았어요 — 직접 확인해 주세요\n{summary}', { max, summary: v.summary }) });
    addLog(s, { k: 'sys', text: t('판정: {name}의 일에 고칠 점이 남았어요 ({max}번 고치게 함) — {summary}', { name: worker.name, max, summary: v.summary }) });
    broadcast({ type: 'notice', level: 'warn', text: t('{name}의 일에 아직 문제가 남아 있어요. 검사 보고와 기록을 확인해 주세요.', { name: worker.name }) });
    report({ state: 'left', note: t('{max}번 고치게 했는데도 문제가 남았어요. 직접 확인해 주세요.', { max }) });
    return;
  }
  addLog(worker, { k: 'sys', text: t('{name}{ga} 고칠 점을 찾았어요 — {summary}', { name: who, ga: josa(who, '이', '가'), summary: v.summary }) });
  addLog(s, { k: 'sys', text: t('판정: {name}에게 다시 고치게 해요 ({n}/{max}) — {summary}', { name: worker.name, n: review.round + 1, max, summary: v.summary }) });
  report({ state: 'fixing', round: review.round + 1, max });
  worker.queue.push({
    id: newId(), text: `${t('[{name} 수정 요청 {n}/{max}]', { name: who, n: review.round + 1, max })} ${v.fix || v.summary}`,
    round: review.round + 1, task: review.task, reportId: rid, planTask: review.planTask || undefined,
  });
  sendAgent(worker);
  pump(worker);
}

// ── 팀장: 큰 일을 받아 계획을 세우고(허락받고) 일꾼들에게 나눠 맡긴 뒤, 다 끝나면 결과를 모아 보고한다 ──

function markPlan(id, patch) {
  const p = plans.find(x => x.id === id);
  if (!p) return null;   // 그사이 기록을 지웠으면 그냥 둔다
  Object.assign(p, patch, { updatedAt: Date.now() });
  broadcast({ type: 'plan', plan: p });
  save();
  return p;
}

function apiLead(text, files = []) {
  if (!stageOn('lead')) return fail(400, t('팀장이 꺼져 있어요. 에이전트 관리 창에서 먼저 켜 주세요.'));
  // 첨부는 팀장이 읽는 기본 작업 폴더와 일꾼들의 작업 폴더마다 같은 자리(attachments/)에 넣는다 (어느 일꾼이 맡을지 아직 모른다)
  let note = '';
  for (const dir of [...new Set([settings.defaultCwd, ...agents.map(a => a.cwd)])].filter(isDir)) {
    const got = copyAttachments(files, dir);
    if (!note) note = attachNote(got);
  }
  const p = { id: newId(), request: (text + note).slice(0, 8000), state: 'planning', plan: '', tasks: [], final: '', note: '', at: Date.now() };
  plans.unshift(p);
  if (plans.length > PLAN_KEEP) plans.length = PLAN_KEEP;
  markPlan(p.id, {});
  queueLead(p, 'plan');
  return [200, { ok: true, sentTo: ['lead'], planId: p.id }];
}

function queueLead(p, phase) {
  const lead = staff.lead;
  lead.queue.push({ id: newId(), text: leadPrompt(p, phase), quiet: true, plan: { planId: p.id, phase } });
  addLog(lead, { k: 'user', text: `${phase === 'plan' ? t('계획 세우기') : t('결과 모으기')} — ${firstLine(p.request).slice(0, 80)}` });
  sendAgent(lead);
  pump(lead);
}

const TASK_KO = { done: '끝남', left: '문제 남음', error: '오류', stopped: '중단' };

function leadPrompt(p, phase) {
  if (phase === 'plan') {
    return [
      t('[계획 요청] 사용자가 큰 일을 맡겼어요. 일꾼들에게 나눠 맡길 계획을 세워 주세요.'),
      '', t('## 사용자가 시킨 일'), p.request,
      '', t('## 일꾼 (이름 · 역할 · 작업 폴더)'),
      ...agents.map(a => `- ${a.name} · ${firstLine(a.role).trim() || t('역할 없음')} · ${a.cwd}`),
      '', t('## 규칙'),
      t('- 일꾼 수 이하의 조각으로 나누세요. 혼자 해도 되는 작은 일이면 한 명에게만 맡겨도 돼요.'),
      t('- 두 일꾼이 같은 파일을 고치지 않게 파일·폴더 단위로 나누세요. 역할이 있으면 역할에 맞게 맡기세요.'),
      t('- 각 조각은 그 일꾼이 다른 설명 없이 바로 할 수 있게, 만들 파일과 지킬 것을 구체적으로 적으세요.'),
      t('- 지금 폴더의 파일을 읽어 봐도 되지만, 고칠 수는 없어요.'),
      t('- 어떤 조각이 다른 조각이 만든 파일을 써야 한다면(예: 기능을 만든 뒤에 그 기능의 시험 돌리기) after 에 먼저 끝나야 할 조각 번호를 적으세요. 조각 번호는 tasks 의 순서대로 1부터이고, 앞 번호만 적을 수 있어요. 기다릴 필요가 없으면 after 를 빈 칸([])으로 두세요. 기다리는 조각은 앞 조각이 검사까지 끝난 뒤에 시작해서 그만큼 늦어지니, 꼭 필요할 때만 쓰세요.'),
      '', t('짧게 설명한 뒤 마지막 줄에 아래 형식의 JSON 한 줄만 적으세요. worker 에는 위 일꾼 이름을 그대로 적으세요.'),
      t('{"plan":"계획 한두 문장","tasks":[{"worker":"일꾼 이름","task":"맡길 일","after":[]}]}'),
    ].join('\n');
  }
  return [
    t('[결과 모으기] 계획한 일이 모두 끝났어요. 사용자에게 올릴 최종 보고를 써 주세요.'),
    '', t('## 사용자가 시킨 일'), p.request,
    '', t('## 계획'), p.plan || t('(없음)'),
    '', t('## 일꾼별 결과'),
    ...p.tasks.flatMap(x => [
      `### ${x.workerName} · ${t(TASK_KO[x.state] || x.state)}`,
      `${t('맡은 일:')} ${firstLine(x.text)}`,
      ...(x.review ? [`${t('검사:')} ${x.review}`] : []),
      `${t('일꾼의 마지막 보고:')} ${String(x.result || t('(없음)')).slice(0, 1500)}`,
    ]),
    '', t('지금 폴더의 파일을 직접 읽어서 일꾼들의 결과가 서로 잘 맞는지(이름·연결·빠진 부분) 확인하세요.'),
    t('보고에는 무엇이 됐는지, 남은 문제, 사용자가 해야 할 일을 짧게 적으세요. JSON 은 쓰지 마세요.'),
  ].join('\n');
}

// 팀장 답의 마지막 JSON 한 줄에서 계획을 읽는다
function parsePlan(text) {
  const lines = String(text || '').split('\n').filter(l => l.includes('"tasks"')).reverse();
  for (const line of lines) {
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const v = JSON.parse(line.slice(start, end + 1));
      const tasks = Array.isArray(v.tasks) ? v.tasks.filter(x => x && typeof x.task === 'string' && x.task.trim()).slice(0, MAX_AGENTS) : [];
      // after: 먼저 끝나야 할 조각 번호(1부터). 자기보다 앞 번호만 받아서 서로 기다리다 멈추는 일이 없게 한다
      const before = (x, i) => [...new Set((Array.isArray(x.after) ? x.after : []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= i))];
      if (tasks.length) return { plan: String(v.plan || '').slice(0, 600), tasks: tasks.map((x, i) => ({ worker: String(x.worker || '').trim(), task: x.task.trim().slice(0, 4000), after: before(x, i) })) };
    } catch { /* 다음 줄 */ }
  }
  return null;
}

// 팀장이 적은 일꾼 이름을 실제 일꾼으로 바꾼다 (모르는 이름이면 아직 일을 덜 받은 일꾼에게)
function resolveWorker(name, used) {
  const key = name.toLowerCase();
  const exact = agents.find(a => a.name === name) || agents.find(a => a.name.toLowerCase() === key);
  if (exact) return exact;
  return agents.reduce((best, a) => ((used.get(a.id) || 0) < (used.get(best.id) || 0) ? a : best), agents[0]);
}

function finishLead(ref, status, text) {
  const p = plans.find(x => x.id === ref.planId);
  if (!p || p.state === 'stopped') return;
  if (status !== 'done') {
    markPlan(p.id, { state: 'stopped', note: status === 'stopped' ? t('팀장을 멈췄어요') : t('팀장이 일하다가 오류가 났어요') });
    return;
  }
  if (ref.phase === 'report') {
    markPlan(p.id, { state: 'done', final: stripVerdict(text).slice(0, 8000) });
    addLog(staff.lead, { k: 'sys', text: t('최종 보고를 올렸어요') });
    broadcast({ type: 'notice', level: 'ok', text: t('팀장이 최종 보고를 올렸어요') });
    return;
  }
  const parsed = parsePlan(text);
  if (!parsed) {
    markPlan(p.id, { state: 'stopped', note: t('팀장의 계획을 읽지 못했어요 — 팀장 칸의 과정을 확인해 주세요') });
    return;
  }
  const used = new Map();
  const tasks = parsed.tasks.map(x => {
    const a = resolveWorker(x.worker, used);
    used.set(a.id, (used.get(a.id) || 0) + 1);
    return { id: newId(), workerId: a.id, workerName: a.name, color: a.color, text: x.task, state: 'waiting', result: '', review: '', after: [] };
  });
  parsed.tasks.forEach((x, i) => { tasks[i].after = x.after.map(n => tasks[n - 1].id); });
  markPlan(p.id, { state: 'proposed', plan: parsed.plan, tasks });
  addLog(staff.lead, { k: 'sys', text: t('계획을 세웠어요: 일꾼 {n}명에게 {m}개 조각', { n: used.size, m: tasks.length }) });
  if (!settings.lead.approve) startPlan(p);
}

// 계획을 시작한다: 기다릴 앞 조각이 없는 조각은 바로 맡기고, 있는 조각은 'blocked' 로 두었다가 앞 조각이 끝나면 맡긴다
function startPlan(p) {
  markPlan(p.id, { state: 'running', note: '' });
  for (const x of p.tasks) x.state = x.after?.length ? 'blocked' : x.state;
  for (const x of p.tasks) if (x.state !== 'blocked') queueTask(p, x);
  markPlan(p.id, {});
}

// 계획 조각 하나를 그 일꾼에게 맡긴다. 앞 조각이 있으면 그 결과(검사 요약)도 같이 알려 준다
function queueTask(p, x) {
  const ref = { planId: p.id, taskId: x.id };
  const a = agents.find(w => w.id === x.workerId);
  if (!a) { planTaskEnd(ref, 'stopped'); return; }
  const others = p.tasks.filter(o => o !== x).map(o => `- ${o.workerName}: ${firstLine(o.text).slice(0, 120)}`);
  const done = p.tasks.filter(d => x.after?.includes(d.id)).map(d => `- ${d.workerName}: ${firstLine(d.text).slice(0, 120)}${d.review ? ` — ${String(d.review).slice(0, 400)}` : ''}`);
  const text = [
    `${t('[팀장이 나눈 일 {i}/{n}]', { i: p.tasks.indexOf(x) + 1, n: p.tasks.length })} ${x.text}`,
    '', `${t('전체 목표:')} ${p.request.slice(0, 1500)}`,
    ...(done.length ? ['', t('먼저 끝난 조각 (이 결과 위에서 이어서 하세요):'), ...done] : []),
    ...(others.length ? ['', t('같이 하는 일꾼 (이 일꾼들이 맡은 파일은 건드리지 마세요):'), ...others] : []),
  ].join('\n');
  a.queue.push({ id: newId(), text, planTask: ref });
  x.state = 'queued';
  sendAgent(a);
  pump(a);
}

// 앞 조각이 모두 끝난 조각을 맡긴다. 앞 조각 중 하나라도 끝나지 못했으면(오류·중단) 그 조각도 시작하지 않는다
function releaseBlocked(p) {
  for (let changed = true; changed;) {
    changed = false;
    for (const x of p.tasks) {
      if (x.state !== 'blocked') continue;
      const deps = p.tasks.filter(d => x.after?.includes(d.id));
      if (deps.some(d => !TASK_DONE.includes(d.state))) continue;
      if (deps.every(d => d.state === 'done' || d.state === 'left')) queueTask(p, x);
      else {
        x.state = 'stopped';
        x.review = t('앞 조각이 끝나지 못해서 시작하지 않았어요');
        changed = true;   // 이 조각을 기다리던 다른 조각도 다시 본다
      }
    }
  }
}

function cancelPlan(p) {
  for (const a of agents) {
    const before = a.queue.length;
    a.queue = a.queue.filter(q => q.planTask?.planId !== p.id);
    if (a.queue.length !== before) sendAgent(a);
  }
  const lead = staff.lead;
  lead.queue = lead.queue.filter(q => q.plan?.planId !== p.id);
  for (const x of p.tasks) if (!TASK_DONE.includes(x.state) && x.state !== 'working' && x.state !== 'fixing') x.state = 'stopped';
  markPlan(p.id, { state: 'stopped', note: t('계획을 취소했어요. 하고 있던 일은 끝까지 해요.') });
  if (lead.current?.plan?.planId === p.id) stopAgent(lead);
  sendAgent(lead);
}

// 계획 조각 하나를 고친다 (quiet 이면 화면에 바로 보내지 않는다)
function planTaskPatch(pt, patch, quiet) {
  const p = plans.find(x => x.id === pt.planId);
  const x = p?.tasks.find(y => y.id === pt.taskId);
  if (!x || TASK_DONE.includes(x.state)) return null;
  Object.assign(x, patch);
  if (!quiet) markPlan(p.id, {});
  return p;
}

// 계획 조각이 끝났다. 모든 조각이 끝나면 팀장에게 결과를 모으게 한다
function planTaskEnd(pt, state, review) {
  const p = planTaskPatch(pt, { state, ...(review ? { review } : {}) });
  if (!p || p.state !== 'running') return;
  releaseBlocked(p);
  markPlan(p.id, {});
  if (!p.tasks.every(x => TASK_DONE.includes(x.state))) return;
  if (!p.tasks.some(x => x.state === 'done' || x.state === 'left')) {   // 하나도 끝나지 못했으면 모을 결과가 없다 (팀장 사용량을 아낀다)
    markPlan(p.id, { state: 'stopped', note: t('나눈 일이 하나도 끝나지 못해서 결과를 모으지 않았어요') });
    return;
  }
  if (stageOn('lead')) {
    markPlan(p.id, { state: 'reporting' });
    queueLead(p, 'report');
  } else markPlan(p.id, { state: 'done', note: t('팀장이 꺼져 있어서 결과를 모으지 않았어요') });
}

function enqueue(a, text, extra = {}) {
  a.queue.push({ id: newId(), text, ...extra });
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

function bootCode() {
  const now = Date.now();
  for (const [k, until] of BOOT) if (until < now) BOOT.delete(k);
  const k = crypto.randomBytes(16).toString('hex');
  BOOT.set(k, now + BOOT_TTL);
  return k;
}

// 한 번만 쓰는 번호가 붙은 주소로 창을 연다. --no-open 이면 창 대신 그 주소를 찍어 준다 (다른 브라우저로 열거나 자동 시험에서 쓴다)
function openWindow() {
  const url = `http://${HOST}:${PORT}/?k=${bootCode()}`;
  if (!OPEN_WINDOW) return console.log(t('브라우저에서 이 주소를 열어 주세요 (한 번만 쓸 수 있어요): {url}', { url }));
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

const hasSession = req => (req.headers.cookie || '').split(';').some(c => c.trim() === `${COOKIE}=${TOKEN}`);

// 창 열기 번호로 들어온 창: 번호를 지우고 (맞으면 쿠키를 주고) 번호 없는 주소로 보낸다
function enterWithCode(res, k) {
  const ok = BOOT.get(k) > Date.now();
  BOOT.delete(k);
  res.writeHead(302, {
    Location: '/',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    ...(ok && { 'Set-Cookie': `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/` }),
  });
  res.end();
}

// 쿠키 없이 화면을 달라는 요청: 열쇠 없이 다시 여는 법만 알려 준다
function serveLocked(res) {
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  res.end(`<!doctype html><html lang="${settings.lang === 'en' ? 'en' : 'ko'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t('클로드 관제실')}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#141413;color:#ece9e2;font:15px/1.6 system-ui,sans-serif;text-align:center">
<div><h1 style="font-size:19px;margin:0 0 8px">${t('이 창에는 열쇠가 없어요')}</h1><p style="margin:0;color:#a39e93">${t('관제실을 켤 때처럼 실행.bat(바탕화면의 클로드 관제실)을 다시 눌러 주세요. 열쇠가 든 새 창이 열려요.')}</p></div>`);
}

function openStream(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 1500\n\n');
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// ── 파일 첨부: 화면에서 올린 파일을 잠깐 기록 폴더의 uploads 에 두었다가, 보낼 때 받는 에이전트의 작업 폴더 attachments/ 에 복사한다 ──
// 작업 폴더 안에 두어야 Claude 는 따로 허락 없이 읽고, GPT 는 샌드박스 안에서 읽는다. 사진은 GPT 에게 --image 로도 넘긴다 (경로만으로는 못 본다)
const MAX_UPLOAD = 25 * 1024 * 1024;   // 파일 하나 25MB
const MAX_ATTACH = 10;                 // 한 번에 보내는 파일 수
const MAX_STAGED = 50;                 // 보내기 전에 올려 둘 수 있는 파일 수
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const uploads = new Map();             // id → { id, name, size, file } (서버를 다시 켜면 비운다)
const uploadDir = () => path.join(DATA_DIR, 'uploads');

// 파일 이름에서 폴더 부분·윈도에서 못 쓰는 글자·예약 이름을 걷어 낸다 (작업 폴더 밖으로 나가지 못하게)
function safeName(raw) {
  let n = String(raw || '').replace(/\\/g, '/').split('/').pop() || '';
  n = n.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\s+/, '').replace(/[.\s]+$/, '');
  if (!n || /^\.+$/.test(n)) n = 'file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(n)) n = `_${n}`;
  if (n.length > 80) { const ext = path.extname(n).slice(0, 12); n = n.slice(0, 80 - ext.length) + ext; }
  return n;
}

const sizeText = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// POST /api/attachments?name=… 몸통이 파일 내용이다 (JSON 이 아니다). 너무 크면 끝까지 받아 버리고 413 을 준다
function apiUpload(req, rawName) {
  return new Promise(resolve => {
    const refuse = (status, msg) => { req.resume(); req.on('end', () => resolve(fail(status, msg))); };
    if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return refuse(413, t('파일이 너무 커요 (한 파일에 25MB까지)'));
    if (uploads.size >= MAX_STAGED) return refuse(400, t('올려 둔 파일이 너무 많아요. 먼저 보내거나 지워 주세요.'));
    const id = newId();
    const name = safeName(rawName);
    try { fs.mkdirSync(uploadDir(), { recursive: true }); } catch { /* 아래 쓰기에서 알려 준다 */ }
    const file = path.join(uploadDir(), id);
    const out = fs.createWriteStream(file);
    let size = 0;
    let over = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_UPLOAD) over = true;
      if (!over) out.write(c);
    });
    req.on('end', () => out.end(() => {
      if (over) { fs.rm(file, { force: true }, () => {}); return resolve(fail(413, t('파일이 너무 커요 (한 파일에 25MB까지)'))); }
      uploads.set(id, { id, name, size, file });
      resolve([200, { ok: true, id, name, size }]);
    }));
    req.on('error', () => { out.destroy(); fs.rm(file, { force: true }, () => {}); resolve(fail(400, t('파일을 받지 못했어요'))); });
    out.on('error', e => { req.resume(); resolve(fail(400, t('파일을 저장하지 못했어요: {why}', { why: e.message }))); });
  });
}

function dropUpload(id) {
  const u = uploads.get(id);
  if (!u) return;
  uploads.delete(id);
  fs.rm(u.file, { force: true }, () => {});
}

// 보낼 때 고른 첨부 id 들을 확인한다
function pickUploads(ids) {
  if (ids === undefined) return { files: [] };
  if (!Array.isArray(ids) || ids.length > MAX_ATTACH) return { error: t('첨부 파일은 한 번에 {n}개까지 보낼 수 있어요', { n: MAX_ATTACH }) };
  const files = ids.map(id => uploads.get(String(id)));
  if (files.some(f => !f)) return { error: t('첨부 파일을 찾지 못했어요. 다시 올려 주세요.') };
  return { files };
}

// 첨부를 한 작업 폴더의 attachments/ 에 복사한다. 같은 이름이 있으면 '이름 (2).확장자' 처럼 피한다
function copyAttachments(files, cwd) {
  if (!files.length) return [];
  const dir = path.join(cwd, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  return files.map(f => {
    const ext = path.extname(f.name);
    const base = f.name.slice(0, f.name.length - ext.length);
    for (let i = 1; ; i++) {
      const name = i === 1 ? f.name : `${base} (${i})${ext}`;
      const abs = path.join(dir, name);
      try {
        fs.copyFileSync(f.file, abs, fs.constants.COPYFILE_EXCL);
        return { rel: `attachments/${name}`, abs, size: f.size, image: IMAGE_EXT.test(name) };
      } catch (e) {
        if (e.code !== 'EEXIST' || i > 50) throw e;
      }
    }
  });
}

const attachNote = got => (got.length
  ? `\n\n${t('[첨부 파일] 사용자가 보낸 파일을 작업 폴더에 넣어 두었어요. 필요하면 열어 보세요:')}\n${got.map(f => `- ${f.rel} (${sizeText(f.size)})`).join('\n')}`
  : '');

function apiSend(b) {
  const text = cleanText(b.text);
  if (!text) return fail(400, t('보낼 내용이 비었어요'));
  const { files, error } = pickUploads(b.attachments);
  if (error) return fail(400, error);
  let r;
  try {
    if (b.target === 'lead') r = apiLead(text, files);
    else {
      let targets;
      if (b.target === 'all') targets = agents.slice();
      else if (Array.isArray(b.target)) targets = agents.filter(a => b.target.includes(a.id));
      else targets = [pickAgent()];
      if (!targets.length) return fail(400, t('보낼 에이전트를 골라 주세요'));
      for (const a of targets) {
        const got = copyAttachments(files, a.cwd);
        enqueue(a, text + attachNote(got), { images: got.filter(f => f.image).map(f => f.abs) });
      }
      r = [200, { ok: true, sentTo: targets.map(a => a.id) }];
    }
  } catch (e) {
    return fail(400, t('첨부 파일을 작업 폴더에 넣지 못했어요: {why}', { why: e.message }));
  }
  if (r[0] === 200) for (const f of files) dropUpload(f.id);   // 보낸 첨부는 작업 폴더로 옮겨졌으니 맡아 둔 것은 지운다
  return r;
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
  for (const s of staffList()) s.name = t(STAFF_NAME[s.staff]);
  for (const a of agents) {
    const m = a.name.match(/^(?:클로드|Claude) (\d+)$/);
    if (m) a.name = t('클로드 {n}', { n: m[1] });
  }
  for (const a of allAgents()) {
    if (a.proc && a.proc.mode !== 'codex') { if (a.current) a.dirty = true; else closeProc(a); }
    if (a.codexThread) a.langNote = true;
  }
  sendAgents();
  staffList().forEach(sendAgent);
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
  if (typeof b.notify === 'boolean') settings.notify = b.notify;
  if (typeof b.effects === 'boolean') settings.effects = b.effects;
  for (const k of STAFF_KEYS) {
    const s = b[k];
    if (!s || typeof s !== 'object') continue;
    const cfg = settings[k];
    if (typeof s.enabled === 'boolean') cfg.enabled = s.enabled;
    if (ENGINES.includes(s.engine)) cfg.engine = s.engine;
    if (MODELS.includes(s.model)) cfg.model = s.model;
    if (typeof s.gptModel === 'string' && GPT_MODEL.test(s.gptModel)) cfg.gptModel = s.gptModel;
    if (k === 'supervisor' && [1, 2, 3].includes(Number(s.maxRounds))) cfg.maxRounds = Number(s.maxRounds);
    if (k === 'lead' && typeof s.approve === 'boolean') cfg.approve = s.approve;
    if (!cfg.enabled && staff[k].queue.length) staff[k].queue = [];   // 끄면 기다리던 일은 버린다 (하던 일은 끝까지 한다)
    sendAgent(staff[k]);
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
  if (method === 'GET' && p === '/api/state') return [200, snapshot()];   // 화면이 처음 받는 것과 같은 상태 (자동 시험·스크립트가 읽는다)
  if (method === 'POST' && p === '/api/send') return apiSend(b);
  if (method === 'POST' && p === '/api/agents') return apiAdd();
  if (method === 'POST' && p === '/api/apply-all') return apiApplyAll(b);
  if (method === 'POST' && p === '/api/stop-all') { allAgents().forEach(stopAgent); return OK; }
  if (method === 'POST' && p === '/api/reset-all') { agents.forEach(resetAgent); return OK; }
  if (method === 'POST' && p === '/api/settings') return apiSettings(b);
  if (method === 'POST' && p === '/api/setup') return apiSetup(b);
  if (method === 'POST' && p === '/api/data-dir') return apiDataDir(b);
  if (method === 'POST' && p === '/api/open-data') return openFolder(DATA_DIR);
  if (method === 'GET' && p === '/api/diagnostics') return [200, diagnostics()];
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
  if (method === 'DELETE' && p === '/api/history') { history = []; reports = []; plans = []; broadcast({ type: 'history-clear' }); save(); return OK; }
  if (method === 'POST' && p === '/api/shutdown') { setTimeout(shutdown, 150); return OK; }

  const pm = p.match(/^\/api\/plans\/([\w-]+)\/(start|cancel)$/);
  if (pm && method === 'POST') {
    const plan = plans.find(x => x.id === pm[1]);
    if (!plan) return fail(404, t('그 계획은 이제 없어요'));
    if (pm[2] === 'start') {
      if (plan.state !== 'proposed') return fail(400, t('허락을 기다리는 계획만 시작할 수 있어요'));
      startPlan(plan);
    } else {
      if (!PLAN_LIVE.includes(plan.state)) return fail(400, t('이미 끝난 계획이에요'));
      cancelPlan(plan);
    }
    return OK;
  }

  const m = p.match(/^\/api\/agents\/([\w-]+)(?:\/([\w-]+))?(?:\/([\w-]+))?$/);
  if (!m) return fail(404, t('없는 주소예요'));
  const a = staff[m[1]] || agents.find(x => x.id === m[1]);
  if (!a) return fail(404, t('그 에이전트는 이제 없어요'));
  const act = m[2];
  // 관리하는 자리는 멈추기·새 대화·허락 답하기만 된다 (설정은 관리 창에서, 일은 저절로 받는다)
  if (a.staff && !(method === 'POST' && ['stop', 'reset', 'permission'].includes(act))) return fail(400, t('관리하는 자리는 멈추기와 허락만 할 수 있어요'));
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
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (url.searchParams.has('k')) return enterWithCode(res, url.searchParams.get('k'));
    return hasSession(req) ? serveIndex(res) : serveLocked(res);
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: t('없는 주소예요') });
  // 화면 연결(EventSource)은 머리글을 못 붙여 쿠키로 연다. 다른 출처의 페이지는 이 연결을 읽을 수 없다
  const events = req.method === 'GET' && url.pathname === '/api/events';
  if (req.headers['x-token'] !== TOKEN && !(events && hasSession(req))) {
    return sendJson(res, 401, { error: t('화면을 새로 고침해 주세요 (열쇠가 맞지 않아요)') });
  }
  if (events) return openStream(req, res);
  if (req.method === 'POST' && url.pathname === '/api/attachments') {   // 몸통이 파일 그대로라 JSON 으로 읽지 않는다
    const [status, data] = await apiUpload(req, url.searchParams.get('name'));
    return sendJson(res, status, data);
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/attachments/')) {
    dropUpload(url.pathname.slice('/api/attachments/'.length));
    return sendJson(res, 200, { ok: true });
  }
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

fs.mkdirSync(HOME, { recursive: true });
loadState();
if (settings.defaultCwd === WORKDIR) fs.mkdirSync(WORKDIR, { recursive: true });

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    // 이미 켜진 관제실에게 쪽지로 창을 열어 달라고 한다 (열쇠는 그쪽만 안다)
    console.log(t('이미 켜져 있어요 (포트 {port}). 화면 창만 다시 열게요.', { port: PORT }));
    try { fs.writeFileSync(openRequest(), ''); } catch { /* 데이터 폴더가 없다 = 그 포트를 다른 프로그램이 쓰고 있다 */ }
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // 여기부터는 이 서버가 포트를 잡은 뒤에만 한다 (또 켠 쪽이 켜져 있는 쪽의 첨부를 지우지 않게)
  try { fs.rmSync(uploadDir(), { recursive: true, force: true }); } catch { /* 보내지 않고 남은 첨부 (지난번에 켰을 때 것) */ }
  try { fs.rmSync(openRequest(), { force: true }); } catch { /* 지난번 쪽지 */ }
  setInterval(() => {
    if (!fs.existsSync(openRequest())) return;
    try { fs.rmSync(openRequest(), { force: true }); } catch { /* 지우지 못하면 다음에 또 연다 */ }
    openWindow();
  }, 1000).unref();
  banner();
  detectClaude();
  detectCodex();
  ensureCcr();
  console.log(claude.path ? t('claude 위치: {path}', { path: claude.path }) : t('claude 를 찾지 못했어요. 화면의 설정 창에서 위치를 알려 주세요.'));
  openWindow();
});

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000).unref();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
