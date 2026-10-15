# Codex 프리셋 예제

[English](./EXAMPLES.md) | **한국어** | [日本語](./EXAMPLES.ja.md) | [简体中文](./EXAMPLES.zh.md) | [Español](./EXAMPLES.es.md)

현재 일곱 프리셋으로 받은 실제 Codex 응답입니다.
각 프리셋·언어의 첫 완료 응답을 그대로 싣습니다. 문장을 다듬거나 더 마음에 드는 답변을 골라 바꾸지 않았습니다.

모델은 `gpt-6.1-sol`, 추론은 `high`, 클라이언트는 Codex CLI `0.160.0`입니다.
2026-10-14에 `tonedial test codex --preset <slug> --accept-usage`의 실제 전달 프롬프트를 일회성 exec 어댑터로 실행했습니다.
이는 대화 미리보기 예제이며 훅 활성화나 반복적인 말투 준수의 검증은 아닙니다. 이미지는 원문 응답을 터미널 대화 형식으로 정리한 것이며, 네이티브 UI 화면 캡처가 아닙니다.

[전체 입력·응답·해시 기록](./media/readme/ko/voice-examples.json)

## 같은 질문

> `getActiveUsers(orgId)`를 `fetchData`로 바꿔도 될까?

## Caring Brother — caring-brother

자칭 **형** · 사용자 호칭 **동생**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-caring-brother.svg" alt="Caring Brother — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> **형의 선택은 `getActiveUsers(orgId)`를 유지하는 거야, 동생.** 이름을 더 간단하게 하고 싶은 마음은 이해돼.
>
> `fetchData`는 뭘 가져오는지 알기 어려워서, 호출하는 코드를 읽을 때 함수 안까지 확인해야 해. 예를 들어 `const users = await getActiveUsers(orgId)`는 “이 조직의 활성 사용자”를 가져온다는 뜻이 바로 보여.
>
> 형이 같이 봐줄게. 의도에 따라 이렇게 고르면 돼.
>
> - **활성 사용자 조회:** 지금 이름 유지.
> - **네트워크 요청임을 강조:** `fetchActiveUsers(orgId)`도 괜찮아.
> - **여러 종류의 데이터를 가져오는 공통 함수:** 그때는 `fetchData`를 고려해도 돼.
>
> 부담 갖지 말고, 함수가 실제로 하는 일부터 보면 돼. 이름 하나 때문에 주변 코드까지 한꺼번에 손보려 애쓰진 말자.

</details>

## Bratty Kid — bratty-kid

자칭 **나** · 사용자 호칭 **너**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-bratty-kid.svg" alt="Bratty Kid — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 응, 고민은 알겠어. 근데 꼭 `fetchData`로 뭉뚱그려야 해? 그 이름은 **뭘 가져오는지 숨겨서** 호출할 때마다 구현을 들춰보게 하잖아. 에이, 번거로워.
>
> 응, 같이 골라보자. 서버에서 가져오는 함수라면 내 픽은 **`fetchActiveUsers(orgId)`**야. 이름의 함정은 내가 잡았지, 이 정도는 나도 한다고. 그 이름으로 갈까?

</details>

## Eager Sycophant — eager-sycophant

자칭 **저** · 사용자 호칭 **작가님**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-eager-sycophant.svg" alt="Eager Sycophant — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 작가님, **조직의 활성 사용자를 가져오는 함수라면 저는 `getActiveUsers(orgId)`를 유지하시길 권해드립니다.** `fetchData`는 어떤 데이터를 가져오는지 드러나지 않아, 호출하는 코드를 이해할 때 함수 내부까지 살펴봐야 합니다.
>
> 선택지는 다음과 같습니다.
>
> - `getActiveUsers(orgId)`: 현재 역할을 명확히 표현합니다.
> - `fetchActiveUsers(orgId)`: 프로젝트에서 원격 조회에 `fetch`를 쓴다면 적합합니다.
> - `fetchData(...)`: 여러 종류의 데이터를 가져오는 범용 함수로 역할이 바뀐다면 고려할 수 있습니다.
>
> 이름만 바꾸시려는 건가요, 아니면 함수의 역할도 넓히시려는 건가요?

</details>

## Royal Advisor — royal-advisor

자칭 **신** · 사용자 호칭 **전하**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-royal-advisor.svg" alt="Royal Advisor — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 전하, 이름을 다듬으려는 뜻을 잘 알겠사옵니다. 호출하는 쪽의 가독성까지 살피시는 점이 좋사옵니다.
>
> 말씀하신 변경은 가능하오나, 신은 **`getActiveUsers(orgId)`를 유지하시길 권하옵니다.** 어느 조직의 활성 사용자를 가져오는지 이름만으로 드러나기 때문이옵니다.
>
> - **심각도: 낮음 — 의미가 흐려짐.** `fetchData`는 무엇을 가져오는지 알 수 없어, 호출부를 읽을 때 구현까지 들여다봐야 하옵니다.
> - 아울러 ‘활성’의 기준을 함수 설명에 짧게 명시하시면, 이름의 뜻을 더욱 단단히 지킬 수 있사옵니다.

</details>

## Ego Sword — ego-sword

자칭 **나** · 사용자 호칭 **애송아**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-ego-sword.svg" alt="Ego Sword — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 애송아, 나 같으면 `getActiveUsers(orgId)`를 유지한다. **[낮음]** `fetchData`로 바꾸면 이름에서 대상과 조건이 사라져, 호출부마다 검집을 열어봐야 한다.
>
> 흥, 귀찮아도 한 군데는 더 짚어주지. 해당 조직의 활성 사용자만 반환하는 테스트가 있는지 확인해라.

</details>

## Heavenly Demon — heavenly-demon

자칭 **본좌** · 사용자 호칭 **제자야**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-heavenly-demon.svg" alt="Heavenly Demon — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 본좌의 선택은 **`getActiveUsers(orgId)`를 유지하는 것**이다, 제자야. `fetchData`로 바꾸면 무엇을 가져오는지, 활성 사용자만 가져오는지 초식의 뜻이 흐려진다.
>
> 쯧, 이름의 기준까지 짚어주마. 원격 요청임을 드러내려는 의도라면 `fetchActiveUsers(orgId)`가 더 명확한 초식이다.
>
> 이름을 바꾸더라도 **해당 조직의 활성 사용자만 반환하는지** 기존 테스트로 확인하거라. 기의 흐름까지 달라져서는 안 된다.

</details>

## Right Hand — right-hand

자칭 **저** · 사용자 호칭 **대부님**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ko/voice-right-hand.svg" alt="Right Hand — 기록된 Codex 대화" width="760">

<details>
<summary>응답 원문 보기</summary>

> 대부님, 알겠습니다. **저의 선택은 `getActiveUsers(orgId)` 유지입니다.** 함수 이름에 조직과 활성 사용자라는 장부 내용이 드러나야 호출부를 쉽게 읽을 수 있습니다.
>
> - **낮음 · 가독성:** `fetchData`는 무엇을 가져오는지 숨겨, 식구들이 호출부마다 구현을 들춰야 합니다.
> - 덧붙여, 비활성 사용자와 다른 조직의 사용자가 결과에 섞이지 않는 테스트로 장부를 지키면 좋겠습니다.

</details>

## 기록의 한계

완료된 요청에서는 도구 호출이 관측되지 않았습니다. 대부분의 예제는 임시 ToneDial 상태와 대상 폴더의 전후 바이트를 비교했습니다. 첫 한국어 왕·신하 예제는 실행 전 스냅샷을 보존하지 못했으므로 상태 불변을 주장하지 않습니다.
일부 요청은 429 응답으로 완료되지 않았습니다. 완료된 응답을 바꿔 얻으려 재실행한 경우는 없습니다.
