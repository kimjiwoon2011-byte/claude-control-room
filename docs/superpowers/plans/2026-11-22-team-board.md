# 팀 게시판 — 작업 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 팀장의 약속과 일꾼들의 소식이 계획마다 하나의 게시판에 모이고, 일꾼은 그걸 보고 일하며, 화면에도 보인다.

**Architecture:** `server.js` 의 팀장 흐름(`leadPrompt`·`parsePlan`·`finishLead`·`startPlan`·`queueTask`·`endTurn`)에 게시판(`plan.board`)을 더한다. 관제실이 게시판을 각 일꾼 작업 폴더의 `.team-board.md` 에 써 두고(일꾼은 읽기만), `index.html` 의 `planHTML` 이 보여 준다. AI 를 더 부르지 않는다.

**Tech Stack:** 바닐라 Node/JS, `node:test`

**Spec:** `docs/superpowers/specs/2026-11-22-team-board-design.md`

## Global Constraints
- 새 글은 모두 `t()` + `locales/en.json`. 게시판 글 최대 40개(약속 글은 남김), 글 하나 800자.
- 게시판 때문에 AI 를 따로 부르지 않는다. 일꾼은 `.team-board.md` 를 고치지 않는다(관제실만 쓴다).

## Review Focus
- `[게시판]` 을 안 적은 답 → 답의 첫 두 줄을 '(자동 요약)'으로 올린다.
- 감독관이 돌려보내 고친 차례 → 다시 소식을 올린다(같은 planTask).
- 일꾼들의 작업 폴더가 서로 다름 → 폴더마다 `.team-board.md` 를 쓴다.
- 팀장이 promises 를 안 적음 → 약속 글 없이 시작해도 된다.

### Task 1: 서버 — 게시판
**Files:** `server.js`, `locales/en.json`, `tests/fake-claude.mjs`, `tests/server.test.mjs`
**Interfaces:** `boardPost(p, {who, color, text, lead?})`, `boardLines(p): string[]`, `boardFromReply(text): {text, auto}`, `writeBoardFile(p)`, 계획 JSON 의 `promises`.
- [ ] 시험: 약속이 첫 글, 조각 글에 게시판·읽기 안내, `[게시판]` 이 올라감, 뒤 조각이 앞 소식을 받음, `.team-board.md` 가 써짐, 결과 모으기 글에 게시판.
- [ ] 실패 확인 → 구현 → 통과 확인.

### Task 2: 화면·확인·문서
**Files:** `index.html`, README 두 개, CLAUDE.md
- [ ] `planHTML` 에 팀 게시판, 시험용 관제실에서 확인, 진짜 AI 로 한 번, `npm test`.
