# ToneDial

[English](https://github.com/awesometic/tonedial/blob/main/README.md) | **한국어**

**코딩 에이전트의 말투를 조절하는 다이얼입니다.**

열두 축의 단계를 골라 프리셋으로 저장하고 `TONE.md`로 만듭니다.
미리 작성한 행동 앵커로 컴파일하므로 모델 API나 API 키가 필요 없고 설정이 같으면 결과 바이트도 같습니다.
프리셋 라이브러리는 한곳에 두고 연결은 전역이나 프로젝트별로 선택합니다.

네이티브 통합은 설정된 대화 이벤트마다 컴파일된 말투를 다시 반영합니다.
Claude와 Codex는 답변이 끝난 뒤 말투만 조정하는 보정 요청을 한 번 보낼 수 있습니다.
이 요청은 완료한 도구 작업을 반복하지 않으며 이미 표시한 답변을 조용히 바꾸지도 않습니다.
자세한 내용은 [말투 새로고침과 제한된 말투 피드백](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#hook-refresh-and-bounded-style-feedback)을 참고하세요.

> [!NOTE]
> 아직 출시하지 않은 `0.1.0` 후보 버전입니다. npm과 curl 배포 채널은 아직 열리지 않았습니다.
> Codex, Claude Code, Antigravity IDE·데스크톱 설정 기능은 구현됐지만 실제 호스트 활성화, 스킬 발견, 하루 사용 검증은 아직 마치지 않았습니다.

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/dial.svg" alt="ToneDial 인라인 미리보기: 열두 축의 현재 값과 기본값, 선택한 warmth 설명, 대기 중인 변경과 적용·취소·도움말 키" width="760">

<sub>현재 렌더러에 합성 입력을 넣어 만든 80열 다이얼입니다. 에이전트의 답변을 담은 이미지는 아닙니다. 네이티브 클라이언트나 사용자 상태를 쓰지 않았습니다. <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/ko/dial-example.json">프레임 생성 기록</a> · <a href="https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#current-dial-example">만드는 방법</a>.</sub>

## 사용해 보기

Node 24 이상과 npm이 필요합니다.
이 체크아웃에서 실행하세요.

```bash
npm ci
npm run build
node dist/bin.js init --tools none --global
node dist/bin.js set
```

평소 쓰는 ToneDial 상태의 변경을 승인 전에 미리 보여 주며 에이전트 연결은 선택하지 않습니다.
평소 설정을 건드리지 않고 시험하려면 [격리된 후보 버전 테스트](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate)를 따르세요.
다이얼에서 방향키나 `hjkl`로 이동하고 `1`–`5`로 값을 입력합니다.
Enter는 적용, Esc는 취소, `?`는 도움말입니다.

아직 출시하지 않은 `0.1.0` 후보 버전에서는 npm과 curl 채널을 사용할 수 없습니다.
정식 배포가 열린 뒤에는 다음 명령으로 계속 사용할 CLI를 설치합니다.

```bash
npm install --global tonedial
```

[출시 후 설치 채널 안내](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#installation-channels-after-release)를 참고하세요.
현재 후보 버전은 체크아웃의 [격리된 후보 버전 테스트](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate) 절차를 사용하세요.

계속 사용할 후보 버전을 설치한 뒤 `tonedial init`으로 시작해 연결할 도구를 선택하세요.
연결은 전역을 기본으로 하며 `--here`나 `--project <path>`는 프로젝트를 선택합니다.
말투 라이브러리는 공유합니다.

```bash
tonedial use tough-love
tonedial set warmth=5 critique=5
tonedial set persona.user="서비스를 운영하며 직접적인 트레이드오프를 좋아하는 사람" \
  persona.agent="12년 경력의 가상 SRE 스페셜리스트; 담백하게 말함"
tonedial save "My Tone"
tonedial show
tonedial export my-tone > my-tone.json
```

프리셋 다섯 개가 기본으로 들어 있습니다.
저장한 프리셋에는 축 값만 담기며 페르소나, 호칭, 말높임 설정, 세이프워드는 별도로 유지합니다.
`persona.user`와 `persona.agent`는 각각 유니코드 코드 포인트 200개 이내로 적는 선택 항목이며 빈 값을 넣으면 지웁니다.
에이전트 설명은 가상의 역할극 설정일 뿐 검증된 자격이나 권한을 주지 않습니다.
인터페이스는 영어와 한국어를 지원합니다.
`init` 때 `--lang en` 또는 `--lang ko`를 고릅니다.
초기화한 뒤에는 `tonedial set language=ko`처럼 바꿉니다.
앵커는 영어 한 벌만 쓰며 에이전트의 대화 언어에는 관여하지 않습니다.

Claude Code나 Codex 클라이언트를 설치했다면 새 대화 하나에서 시험해 보세요.

```bash
tonedial test claude        # or: tonedial test codex
tonedial test codex --preset my-tone # try a bundled or user preset without saving
tonedial test claude --json # inspect a plan; launch nothing
```

첫 프롬프트는 대화만 요청하며 파일을 수정하지 말라고 지시합니다.
이번 실행에만 적용하는 옵션으로 기존 말투 훅과 자동 지침을 제외한 미리보기를 요청합니다.
관리 정책과 네이티브 클라이언트의 지원 여부는 별개이며 OS 수준으로 격리하지는 않습니다.
평소 계정의 사용 요금과 기록이 그대로 적용됩니다.
사용 안내를 읽은 뒤 `y`를 입력하면 시작하며 `--accept-usage`는 이번 실행의 사용과 요금에만 동의합니다.
미리보기의 말투 전체가 프로세스 인자에 보일 수 있으므로 페르소나 메모에는 인증 정보나 비공개 내용을 넣지 마세요.

## 사용 전에 알아둘 점

- 말투를 따르도록 요청하며 강제로 적용하지 않습니다. 모델은 요청을 해석하거나 무시하거나 거절할 수 있고 성능이 높은 모델도 답변을 제한하는 단계의 요청을 놓칠 수 있습니다.
- 재미로 쓰는 기능이며 프로덕션 환경에는 권장하지 않습니다. 극단적인 설정은 거친 표현, 아첨, 오해를 부르는 답변을 유도할 수 있습니다.
- 빨간 단계와 `!`는 주의할 기준을 알리며 값을 제한하거나 안전 점수를 나타내지 않습니다. 말투는 호스트 권한이나 승인 요건을 바꾸지 않습니다.
- 세이프워드는 특별한 말투를 뺀 답변 한 번을 요청합니다. `reset`은 ToneDial이 정한 기본 축 값으로 되돌립니다. 둘 다 말투를 계속 꺼 두는 스위치는 아닙니다.
- 설정 생성, 실제 컨텍스트 전달, 모델의 행동은 각각 따로 확인할 항목입니다. `doctor`는 호스트가 말투를 활성화했는지 확인하지 않습니다.
- 인라인 다이얼의 미리보기를 보려면 터미널이 60×24 이상이어야 합니다. 창 크기를 바꾸면 이전 행이 스크롤백에 남을 수 있으며 글꼴과 색상은 터미널마다 다릅니다.

## 더 살펴보기

| 필요한 내용 | 문서 |
| --- | --- |
| 축, 명령, 연결, 복구 | [ToneDial 사용법](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md) |
| 수정, 기능, 통합, 측정 | [기여 안내](https://github.com/awesometic/tonedial/blob/main/CONTRIBUTING.md) |
| 자동화, 설치한 후보 버전, 실제 호스트 점검 | [테스트](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md) |
| 에이전트의 도움을 받는 프로젝트 규칙 | [AGENTS.md](https://github.com/awesometic/tonedial/blob/main/AGENTS.md) |
| 안전한 취약점 제보 | [보안](https://github.com/awesometic/tonedial/blob/main/SECURITY.md) |

[MIT 라이선스](https://github.com/awesometic/tonedial/blob/main/LICENSE) · [서드파티 고지](https://github.com/awesometic/tonedial/blob/main/THIRD_PARTY_NOTICES.md)
