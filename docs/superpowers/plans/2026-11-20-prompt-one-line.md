# 프롬프트 칸 한 줄로 정리 — 작업 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 글 칸 아래를 `[보낼 곳 ▾] 인원 [−] N명 [+] [⚙ 설정 ▾] … 📎 [보내기]` 한 줄로 바꾼다.

**Architecture:** `index.html` 한 파일만 바꾼다. 보낼 곳 칩 줄(`#targets`)과 '모두에게' 줄(`#allBar`)을 없애고, 보낼 곳은 `#targetMenu`, 설정 네 칸은 `#setMenu` 판으로 옮긴다. 두 판은 기존 ⇄·대기 메뉴(`.ai-menu`, `placeMenu`/`closeMenus`)를 함께 쓴다. 서버·API 는 바꾸지 않는다.

**Tech Stack:** 바닐라 JS/CSS (의존성 없음), `node:test`

**Spec:** `docs/superpowers/specs/2026-11-20-prompt-one-line-design.md`

## Global Constraints
- 화면의 새 글은 모두 `t()` 를 거치고 `locales/en.json` 에 영어를 넣는다 (정적 HTML 은 `translatePage` 가 바꾼다).
- 네이티브 `confirm`/`alert` 금지 — 묻기는 `ask()`.
- 인원은 `S.limits` (1~8) 를 따른다. 줄이기는 기존 `removeLast()`, 늘리기는 `POST /api/agents`.
- 시험·미리보기 서버는 반드시 임시 `--home` + `--no-ccr`.

## Review Focus
- 일꾼을 골라 둔 상태에서 그 일꾼을 지우면 → 보낼 곳이 남은 사람으로 줄거나 '자동 배정'으로 돌아가야 한다 (`fixSelections` 가 이미 함, 화면에서 확인).
- 팀장을 끄면 '팀장에게'를 골라 둔 것이 '자동 배정'으로 → 버튼 글자도 바뀌어야 한다.
- 빠른 모드가 켜진 채 설정 판이 접혀 있으면 → ⚙ 버튼에 ↯ 표시.
- 판이 열린 채 Esc·바깥 누르기·창 크기 바꾸기 → 닫혀야 한다.
- 좁은 창 → 줄이 넘어가도 보내기 버튼이 잘리지 않아야 한다.

---

### Task 1: 한 줄 바 (index.html)

**Files:**
- Modify: `index.html` (프롬프트 칸 마크업, CSS, `renderTargets`, `renderAllBar`, `closeMenus`/`placeMenu`, 이벤트 연결, 도움말 `help-tip-2`)
- Modify: `locales/en.json`
- Test: `tests/page.test.mjs`, `tests/i18n.test.mjs` (기존 검사가 새 id·핸들러·번역을 확인)

**Interfaces:**
- Produces: `targetText(): string` (보낼 곳 버튼 글자), `renderTargets()` (버튼 + 열린 메뉴 + 인원 칸 갱신), `toggleMenu(menu, btn)`.

- [ ] 마크업: `#targetBtn`, `#homeDown`/`#homeCount`/`#homeUp`, `#setBtn`(↯ 표시 `#setHot`), `#targetMenu`, `#setMenu` 안에 `#allBar`.
- [ ] `targetText()`: auto→'자동 배정', all→'전체 {n}명', lead→'팀장에게', 한 명→이름, 두 명→'이름·이름', 세 명 이상→'{name} 외 {n}명'.
- [ ] 메뉴: auto/all/lead 는 고르면 닫힘, 일꾼은 켜고 끄며 열린 채.
- [ ] `renderAllBar()`: 판 안에서 그리고, ⚙ 버튼 title 에 네 값 요약, 빠른 모드면 `#setHot` 보이기.
- [ ] `closeMenus`/Esc/바깥 누르기에 두 판 추가, `placeMenu(menu, btn, 'left')` 로 왼쪽 맞춤.
- [ ] 실행: `npm test` → 모두 통과.

### Task 2: 화면에서 확인·문서
- [ ] 임시 관제실(가짜 claude)을 띄워 보낼 곳 고르기 → 보내기(그 일꾼에게 감), 인원 +/−, 설정 바꾸기, Esc/바깥 닫기, 좁은 창, 빠른 모드 ↯ 를 눌러 확인.
- [ ] README 두 개·CLAUDE.md 에서 '모두에게 줄' 설명을 새 위치로 고친다.
