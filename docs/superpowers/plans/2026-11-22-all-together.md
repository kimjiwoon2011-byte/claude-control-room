# '다 같이' 보내기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 보낼 곳 '전체'를 팀장 계획으로 나눠 하나로 모으는 '다 같이'로 바꾸고, 예전 동작은 '각자 따로'로 남긴다.

**Architecture:** `/api/send` 의 `target: 'all'` 을 `apiLead(text, files, { all: true })` 로 보내고, 계획에 `all: true` 를 남겨 팀장 켜기와 상관없이 계획·결과 모으기를 한다. 예전 '모두에게 같은 글'은 새 `target: 'each'`. 화면은 보낼 곳 메뉴·계획판·안내 글만 바꾼다.

**Tech Stack:** Node(의존성 없음) `server.js`, 한 파일 `index.html`, `node:test`, `locales/*.json`.

**Spec:** `docs/superpowers/specs/2026-11-22-all-together-design.md`

## Global Constraints

- 새 글·바뀐 글은 모두 `t()` 를 거치고 `en.json`·`ja.json`·`zh.json`·`fr.json`·`de.json` 에 같은 열쇠로 들어간다 (`npm test` 의 i18n 시험).
- 쓰지 않게 된 사전 글은 모든 사전에서 지운다.
- 시험 서버는 언제나 임시 `--home` 과 `--no-ccr` 로만 띄운다.

## Review Focus

- 팀장이 꺼진 채 '다 같이'로 보냈을 때 홈 계획판에 계획과 '이대로 시작'이 보여야 한다 (안 보이면 계획이 멈춘다) → Task 2 화면 확인.
- 팀장이 꺼져 있을 때 계획판의 '모두 보기 →'(팀장 칸으로 가는 링크)는 갈 곳이 없으니 숨긴다 → Task 2.
- 일꾼이 1명이면 계획 없이 바로 보낸다 → Task 1 시험.
- '다 같이' 계획은 팀장이 꺼져 있어도 다 끝나면 결과를 모은다 (예전엔 '팀장이 꺼져 있어서 결과를 모으지 않았어요') → Task 1 시험.
- 첨부를 붙여 '다 같이'로 보내면 지금 팀장 경로처럼 일꾼 폴더마다 들어간다 → 기존 '팀장에게 보내면 일꾼들의 작업 폴더마다' 시험을 'all' 로도 확인.

---

### Task 1: 서버 — 'all' 은 팀장 계획, 'each' 는 예전 동작

**Files:**
- Modify: `server.js` (`apiSend`, `apiLead`, `planTaskEnd` 의 결과 모으기 조건)
- Test: `tests/server.test.mjs`

**Interfaces:**
- Produces: `/api/send` 가 받는 `target`: `'auto' | 'all' | 'each' | 'lead' | string[]`. 'all' 의 응답은 일꾼 2명 이상이면 `{ ok, sentTo: ['lead'], planId }`, 1명이면 `{ ok, sentTo: [id] }`.
- Produces: 계획 객체에 `all: true` (상태 저장·방송에 그대로 실림).

- [ ] **Step 1: 시험 쓰기** — `'다 같이: 팀장이 꺼져 있어도 계획을 세우고, 시작하면 나눠 맡기고, 다 끝나면 결과를 모은다'`: 일꾼 2명(seed), 팀장 꺼짐, `POST /api/send {text:'큰 일', target:'all'}` → 응답 `sentTo` 가 `['lead']`, `state.plans[0].all === true`, 계획이 `proposed` 가 되면 `/api/plans/:id/start`, 끝내 `plans[0].state === 'done'` 이고 `final` 이 있다 (가짜 팀장의 '최종 보고'). `'다 같이: 일꾼이 1명이면 그 한 명에게 바로 보낸다'`: 일꾼 1명 → `sentTo` 가 `['a1']`, `plans` 비어 있음. `'각자 따로: 모든 일꾼에게 같은 글을 보낸다'`: 일꾼 2명, `target:'each'` → 두 일꾼의 `user` 기록이 같은 글.
- [ ] **Step 2: 돌려서 실패 확인** — `node --test --test-name-pattern="다 같이|각자 따로" tests/server.test.mjs` → FAIL.
- [ ] **Step 3: 구현** — `apiSend`: `'each'` 는 지금의 `'all'` 갈래(모든 일꾼에게 `copyAttachments`+`enqueue`). `'all'` 은 `agents.length < 2` 면 그 일꾼에게 바로, 아니면 `apiLead(text, files, { all: true })`. `apiLead(text, files, { all = false } = {})`: `!all && !stageOn('lead')` 일 때만 꺼져 있다고 거절, 계획에 `all` 을 넣는다. 결과 모으기 조건 `stageOn('lead')` → `stageOn('lead') || p.all`.
- [ ] **Step 4: 돌려서 통과 확인** — 같은 명령 → PASS, 그리고 기존 '팀장' 시험들도 PASS.

### Task 2: 화면 — 보낼 곳 메뉴, 계획판, 안내 글, 사전

**Files:**
- Modify: `index.html` (`targetText`, `renderTargetMenu`, 메뉴 클릭 처리, `fixSelections`, `renderPlanBoard`, `STAFF_CARD.lead`, 빈 계획 안내, 도움말 `help-how-2`·`help-team-1`)
- Modify: `locales/en.json`, `ja.json`, `zh.json`, `fr.json`, `de.json`
- Test: `tests/i18n.test.mjs`, `tests/page.test.mjs` (그대로 통과해야 함)

**Interfaces:**
- Consumes: Task 1 의 `target: 'all' | 'each'`, 계획의 `all`.

- [ ] **Step 1: 메뉴** — 항목: `auto` '자동 배정' / `all` '다 같이 {n}명' (title '팀장이 일을 나눠 맡기고, 끝나면 하나로 모아요') / `each` '각자 따로 {n}명' (title '모두에게 같은 일을 보내서 각자 만들어요. 비교용이에요 — 같은 폴더면 서로 덮어쓸 수 있어요') / 골라서 보내기. '팀장에게' 항목과 `S.target === 'lead'` 처리(`targetText`, `fixSelections`)는 뺀다. 메뉴 클릭의 단일 선택 목록은 `auto|all|each`.
- [ ] **Step 2: 계획판** — `renderPlanBoard`: 계획을 고르는 조건을 `staffOn('lead') || x.all` 로. '모두 보기 →' 는 `staffOn('lead')` 일 때만.
- [ ] **Step 3: 안내 글** — `STAFF_CARD.lead` 설명: '보낼 곳에서 다 같이를 고르면 팀장이 계획을 세워요(이 자리를 꺼 둬도 돼요). 켜 두면 팀장 칸에서 계획과 진행을 자세히 볼 수 있어요. 계획을 세울 때와 결과를 모을 때 팀장 AI의 사용량이 들어요.' 빈 계획 안내: '아직 세운 계획이 없어요.<br>프롬프트 창의 보낼 곳에서 다 같이를 고르고 큰 일을 보내 보세요.' 도움말 `help-how-2`: '…<b>자동 배정</b>은 가장 한가한 에이전트에게, <b>다 같이</b>는 팀장이 나눠 맡겨 하나로, <b>각자 따로</b>는 모두에게 같은 일을 보내요.' `help-team-1`: '<b>팀장</b> — 보낼 곳에서 <b>다 같이</b>를 고르고 큰 일을 보내면…'(나머지 그대로).
- [ ] **Step 4: 사전** — 새 열쇠·바뀐 열쇠를 다섯 사전에 넣고, 안 쓰게 된 '전체 {n}명'·'모든 에이전트에게 똑같이 보내요'·'팀장에게'(다른 곳에서 안 쓰면)·예전 안내 글 열쇠를 지운다.
- [ ] **Step 5: 확인** — `node --test tests/i18n.test.mjs tests/page.test.mjs` → PASS.

### Task 3: 문서·전체 시험·화면 확인

**Files:**
- Modify: `README.md`, `README.ko.md`, 작업 공간 `CLAUDE.md`

- [ ] **Step 1:** README 두 개의 보낼 곳 설명과 팀장 설명을 '다 같이 / 각자 따로'로 맞춘다. CLAUDE.md 의 `targetText` 목록·`apiLead`·팀장 설명에 'all'=팀장 계획(`all: true`), 'each'=예전 동작을 적는다.
- [ ] **Step 2:** `npm test` → 전부 PASS.
- [ ] **Step 3:** 시험 서버(임시 `--home`, `--no-ccr`, 가짜 CLI)를 브라우저로 열어: 팀장 꺼짐 상태에서 메뉴에 '다 같이'·'각자 따로'가 보이고 '팀장에게'가 없다, '다 같이'로 보내면 홈 계획판에 계획과 '이대로 시작'이 뜨고 누르면 진행되어 최종 보고까지 간다, '모두 보기 →'는 안 보인다.
