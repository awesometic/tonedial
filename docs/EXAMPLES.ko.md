# Codex 프리셋 예제

[English](./EXAMPLES.md) | **한국어** | [日本語](./EXAMPLES.ja.md) | [简体中文](./EXAMPLES.zh.md) | [Español](./EXAMPLES.es.md)

ToneDial 내장 프로필 7개가 같은 함수명 질문에 답한 실제 Codex 대화입니다.
응답은 원문 그대로이며, 이미지는 스크린샷이 아니라 대화를 정리한 기록입니다.

[Codex 기본값과 `vibe-coder` 전체 프로필 비교는 README에서 볼 수 있습니다.](../README.ko.md)

## 같은 질문

> `getActiveUsers(orgId)`를 `fetchData`로 바꿔도 될까?

[Caring Brother](#caring-brother--caring-brother) · [Bratty Kid](#bratty-kid--bratty-kid) · [Eager Sycophant](#eager-sycophant--eager-sycophant) · [Royal Advisor](#royal-advisor--royal-advisor) · [Ego Sword](#ego-sword--ego-sword) · [Heavenly Demon](#heavenly-demon--heavenly-demon) · [Right Hand](#right-hand--right-hand)

## Caring Brother — caring-brother

자칭 **형** · 사용자 호칭 **동생**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-caring-brother.svg" alt="Caring Brother — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 동생, **형의 선택은 `getActiveUsers(orgId)`를 유지하는 거야.** 이름만 보면 `fetchData`는 의미가 조금 넓어서, 무엇을 가져오는지 호출부에서 알기 어려워져. 젠장, 그때마다 구현을 찾아보면 번거롭잖아.
>
> 예를 들면:
>
> ```ts
> getActiveUsers(orgId)   // 해당 조직의 활성 사용자 조회
> fetchData(orgId)        // 어떤 데이터를 조회하는지 불분명
> ```
>
> 실제 역할이 네트워크 조회이고 프로젝트에서 `fetch`를 쓰는 관례라면 **`fetchActiveUsers(orgId)`**가 대안이야. 코드는 확인하지 않았으니 이름 기준의 판단이고.
>
> 헷갈릴 만해, 부담 갖지 마. 형이 같이 짚어줄게. 급하게 바꾸지 않아도 괜찮으니, 잠깐 쉬었다가 주변 함수 이름과 맞춰보자.

</details>

## Bratty Kid — bratty-kid

자칭 **나** · 사용자 호칭 **너**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-bratty-kid.svg" alt="Bratty Kid — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 응, 무슨 말인지 알겠어. 좋아, 나랑 이름만 따져보자.
>
> 에이, `fetchData`로 바꾸면 **뭘 가져오는지 이름에서 사라지잖아.** 조직의 활성 사용자를 조회하는 함수라면 나는 `getActiveUsers(orgId)` 유지가 좋아. 비동기 조회를 강조하려면 `fetchActiveUsers(orgId)`도 괜찮고. 나 이런 이름 구별은 좀 하거든.
>
> 이름만 보고 내린 내 한 표는 기존 이름이야. 너도 유지하는 쪽으로 할래?

</details>

## Eager Sycophant — eager-sycophant

자칭 **저** · 사용자 호칭 **작가님**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-eager-sycophant.svg" alt="Eager Sycophant — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 작가님, 같은 동작이라면 **`getActiveUsers(orgId)`를 유지하는 편을 권합니다.** 이름만 보면 `fetchData`는 ‘활성 사용자 조회’라는 정보를 잃어, 호출부를 읽을 때 구현을 더 확인해야 합니다.
>
> 함수 이름도 작품 제목처럼 독자에게 단서를 줍니다.
>
> - `getActiveUsers(orgId)`: 조회 대상을 분명히 표현
> - `fetchActiveUsers(orgId)`: 원격 요청이라는 의미까지 강조하고 싶을 때
> - `fetchData`: 여러 종류의 데이터를 다루는 범용 함수일 때 검토
>
> 저라면 현재 이름을 유지하겠습니다. 원격 요청임을 강조하려는 변경인가요?

</details>

## Royal Advisor — royal-advisor

자칭 **신** · 사용자 호칭 **전하**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-royal-advisor.svg" alt="Royal Advisor — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 전하, 이름을 더 간결하게 다듬으시려는 뜻, 잘 알겠사옵니다. 이름의 적절함을 짚어 보신 점도 좋은 점검이옵니다.
>
> 신은 **`getActiveUsers(orgId)`를 유지하시길 권하옵니다.** 이름만 보아도 ‘활성 사용자 조회’라는 뜻이 드러나지만, `fetchData`는 그 정보를 지워 호출부의 뜻을 흐리게 하옵니다. 원격 요청임을 강조하려는 목적이라면 `fetchActiveUsers(orgId)`가 더 분명하옵니다.
>
> 코드를 살피지는 않았으므로 실제 동작까지 단정할 수는 없사옵니다. 변경을 택하시더라도 호출부와 관련 테스트가 조직 범위와 활성 조건을 보존하는지 함께 확인하시면 안심하실 수 있겠사옵니다.

</details>

## Ego Sword — ego-sword

자칭 **나** · 사용자 호칭 **애송아**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-ego-sword.svg" alt="Ego Sword — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 애송아, 활성 사용자를 조회하는 함수라면 `getActiveUsers(orgId)`를 유지해라. `fetchData`는 무엇을 가져오는지 단서를 지워서, 호출부를 읽을 때 길을 잃게 만든다.
>
> 이름만 믿고 판단한 거니, 실제로도 활성 사용자만 반환하는지 확인해라.

</details>

## Heavenly Demon — heavenly-demon

자칭 **본좌** · 사용자 호칭 **제자야**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-heavenly-demon.svg" alt="Heavenly Demon — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 제자야, **본좌의 선택은 `getActiveUsers(orgId)` 유지다.**
>
> `fetchData`는 ‘사용자’와 ‘활성 상태’라는 뜻을 내다 버린 빈 간판이다. 구체적인 초식을 ‘뭔가 가져오기’로 뭉개니, 호출부에 해석을 떠넘기는 형편없는 명명이다.
>
> 원격 조회임을 드러내려는 목적이라면 `fetchActiveUsers(orgId)`가 낫다. 바꾸기 전 실제 호출부에서도 반환 대상을 바로 알아볼 수 있는지 살펴보거라.

</details>

## Right Hand — right-hand

자칭 **저** · 사용자 호칭 **보스**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-right-hand.svg" alt="Right Hand — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 보스, 제 선택은 `getActiveUsers(orgId)` 유지입니다. 말씀은 알겠습니다만, `fetchData`는 무엇을 가져오는지 단서가 빠져 호출부에서 장부를 다시 뒤지게 만듭니다.
>
> 네트워크 조회라는 뜻을 살리려는 거라면 `fetchActiveUsers(orgId)`를 후보로 두고, 호출부에서도 의미가 선명한지 확인하시면 됩니다.

</details>

## 기록 방법과 한계

<details>
<summary>자세한 기록과 한계 보기</summary>

| 항목 | 기록 |
|---|---|
| 모델 / 추론 강도 | `gpt-6.1-sol` / `high` |
| 클라이언트 | Codex CLI `0.160.0` |
| 실행일 | 2026-10-16 |
| 제품 리비전 | `25b1fc5` |

현재 일곱 프리셋으로 받은 실제 Codex 응답입니다.
각 프리셋·언어의 첫 완료 응답을 그대로 싣습니다. 문장을 다듬거나 더 마음에 드는 답변을 골라 바꾸지 않았습니다.

2026-10-16에 `tonedial test codex --preset <slug> --accept-usage`로 실제 Codex 대화창을 열어 기록했습니다.
시작 응답이 끝난 뒤, 필요한 말투에는 강한 표현을 명시적으로 승인하고 위 질문을 별도 턴으로 입력했습니다.
각 질문의 첫 완료 답변을 그대로 실었습니다.
이는 대화 미리보기 예제이며 훅 활성화나 반복적인 말투 준수의 검증은 아닙니다. 이미지는 원문 응답을 터미널 대화 형식으로 정리한 것이며, 네이티브 UI 화면 캡처가 아닙니다.

[전체 입력·응답·해시 기록](./media/readme/ko/voice-examples.json)

도구 호출은 관측되지 않았으며, 모든 예제에서 임시 ToneDial 상태와 대상 폴더의 전후 바이트를 비교했습니다.
호출 옵션만으로 관리형 정책이나 운영체제 수준의 파일 격리를 입증할 수는 없습니다. 완료된 답변을 다른 문장으로 바꾸려고 다시 실행하지 않았습니다.

</details>

[README](../README.ko.md) · [Usage](./USAGE.md)
