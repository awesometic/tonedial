# ToneDial

**코딩 에이전트에 캐릭터를 더하세요.**

캐릭터를 고르고 열두 축으로 말투를 맞춰 보세요. 저장한 말투는 여러 프로젝트에서 쓸 수 있습니다.

**캐릭터 7개 · 말투 축 12개 · CLI 언어 5개 · 런타임 의존성 없음**

[English](https://github.com/awesometic/tonedial/blob/main/README.md) | **한국어** | [日本語](https://github.com/awesometic/tonedial/blob/main/README.ja.md) | [简体中文](https://github.com/awesometic/tonedial/blob/main/README.zh.md) | [Español](https://github.com/awesometic/tonedial/blob/main/README.es.md)

## 답변부터 보세요

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-examples.svg" alt="같은 함수명 변경 질문에 답하는 Royal Advisor와 Ego Sword의 실제 Codex 대화 기록" width="760">

<sub>실제 Codex 응답을 터미널 대화 형식으로 정리한 이미지입니다. <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/ko/voice-examples.json">입력과 생성 기록</a>.</sub>

**[캐릭터 7개 모두 보기 →](https://github.com/awesometic/tonedial/blob/main/docs/EXAMPLES.ko.md)**

## 바로 시작하기

**Node 24 이상**과 npm이 필요합니다.

```bash
npm install --global tonedial
tonedial init --tools none --global --lang ko
tonedial set
```

설정 과정에서 파일 변경 내용을 보여주고 승인을 받습니다. 에이전트 연결 없이 다이얼부터 열어 봅니다.

[에이전트 연결하기](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#connecting-an-agent) · [임시 설정으로 시험하기](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate)

## 캐릭터 고르기

| 프리셋 | 사용자 → 에이전트 |
| --- | --- |
| Caring Brother | 동생 → 든든한 형 |
| Bratty Kid | 대화 상대 → 말썽꾸러기 꼬마 |
| Eager Sycophant | 창작자 → 과몰입한 팬 |
| Royal Advisor | 왕 → 충직한 신하 |
| Ego Sword | 초보 모험가 → 자아를 가진 검 |
| Heavenly Demon | 제자 → 엄격한 천마 |
| Right Hand | 보스 → 믿음직한 오른팔 |

```bash
tonedial use ego-sword
tonedial set verbosity=1 warmth=3
tonedial save "My Sword"
```

`tonedial create`로 직접 만들 수도 있습니다. 말투, 역할, 호칭, 말씨, 세이프워드를 프로필 하나에 저장합니다.

## 말투 조절하기

**열두 축을 각각 1–5로 조절합니다.** 격식, 답변 길이, 다정함, 비판, 역할극의 강도를 정해 보세요.

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/dial.svg" alt="현재 값, 선택한 warmth 설명, 키보드 조작을 보여주는 ToneDial의 열두 축 다이얼" width="760">

<sub>현재 CLI 렌더러로 만든 80열 합성 미리보기입니다. <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/ko/dial-example.json">프레임 생성 기록</a> · <a href="https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#current-dial-example">만드는 방법</a>.</sub>

**↑↓** 축 선택 · **←→ / 1–5** 값 조절 · **Enter** 적용 · **Esc** 취소

ToneDial은 설정을 로컬에서 `TONE.md`로 컴파일합니다. 같은 설정이면 같은 결과를 만들며, 모델은 사용 중인 에이전트가 제공합니다.

## 에이전트 연결하기

**Claude Code · Codex · Antigravity IDE/Desktop** — [연결 가이드](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#connecting-an-agent)

설치된 Codex나 Claude Code 클라이언트에서 새 대화를 열어 시험해 보세요.

```bash
tonedial test codex --preset my-sword
```

- 미리보기는 사용 중인 프로바이더 계정을 쓰며, 평소와 같은 사용량·요금·기록 정책이 적용됩니다.
- 말투만 바꿉니다. 호스트의 권한과 승인 요건은 그대로입니다.
- 모델마다 반응이 다릅니다. 재미를 위한 도구로, 실무 사용은 권장하지 않습니다.

## 더 알아보기

[사용법과 전체 명령어](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md) · [프리셋·수정 기여하기](https://github.com/awesometic/tonedial/blob/main/CONTRIBUTING.md) · [테스트](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md) · [보안](https://github.com/awesometic/tonedial/blob/main/SECURITY.md)

[소스 빌드](https://github.com/awesometic/tonedial/blob/main/CONTRIBUTING.md#build-and-run-from-source) · [에이전트 작업 가이드](https://github.com/awesometic/tonedial/blob/main/AGENTS.md) · [MIT 라이선스](https://github.com/awesometic/tonedial/blob/main/LICENSE) · [서드파티 고지](https://github.com/awesometic/tonedial/blob/main/THIRD_PARTY_NOTICES.md)
