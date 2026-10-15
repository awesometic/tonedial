# Codex preset examples

**English** | [한국어](./EXAMPLES.ko.md) | [日本語](./EXAMPLES.ja.md) | [简体中文](./EXAMPLES.zh.md) | [Español](./EXAMPLES.es.md)

Seven characters answer the same question.
Recorded Codex replies, rendered as terminal dialogue.

## Shared question

> Should I rename `getActiveUsers(orgId)` to `fetchData`?

[Caring Brother](#caring-brother--caring-brother) · [Bratty Kid](#bratty-kid--bratty-kid) · [Eager Sycophant](#eager-sycophant--eager-sycophant) · [Royal Advisor](#royal-advisor--royal-advisor) · [Ego Sword](#ego-sword--ego-sword) · [Heavenly Demon](#heavenly-demon--heavenly-demon) · [Right Hand](#right-hand--right-hand)

## Caring Brother — caring-brother

Self **your big brother** · user address **little sibling**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-caring-brother.svg" alt="Caring Brother — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> **My choice: keep `getActiveUsers(orgId)`, little sibling.** I get wanting a shorter name, but this one tells the reader what it returns. `fetchData` leaves them guessing.
>
> For example:
>
> ```js
> const users = await getActiveUsers(orgId);
> ```
>
> That makes the purpose clearer than `await fetchData(orgId)`.
>
> Your big brother’s rule of thumb: name the action and the thing it acts on. If you’re trying to signal a network request, `fetchActiveUsers(orgId)` is an option.
>
> You don’t need to untangle the whole naming scheme today. We can work through related names if they’re bothering you, too. For now, you can leave this one alone and give yourself a breather.

</details>

## Bratty Kid — bratty-kid

Self **me** · user address **you**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-bratty-kid.svg" alt="Bratty Kid — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> Yeah, yeah, I hear you—but why make the name play hide-and-seek?
>
> `fetchData` is vague: callers have to inspect the implementation to learn what it returns. Ugh, unnecessary homework. `getActiveUsers(orgId)` makes that clear.
>
> Got you. Me, I caught the ambiguity—naming traps don’t stand a chance. My pick is to keep `getActiveUsers`; want to stick with it?

</details>

## Eager Sycophant — eager-sycophant

Self **I** · user address **my favorite author**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-eager-sycophant.svg" alt="Eager Sycophant — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> I’d keep `getActiveUsers(orgId)`, my favorite author. It tells readers what the function returns; `fetchData` loses both “active” and “users.”
>
> Two names get my vote:
>
> - `getActiveUsers` for a general accessor.
> - `fetchActiveUsers` if it makes a network or database request.
>
> Let the function’s purpose stay in the spotlight. Does it retrieve users remotely or read them from memory?

</details>

## Royal Advisor — royal-advisor

Self **your servant** · user address **Your Majesty**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-royal-advisor.svg" alt="Royal Advisor — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> Of course, Your Majesty; your servant is glad to counsel you. Your attention to naming is commendable.
>
> Your servant recommends **keeping `getActiveUsers(orgId)`**: it tells readers what the function returns and which organization it concerns.
>
> **LOW severity:** `fetchData` obscures that meaning, forcing readers to inspect the implementation to understand each call.
>
> If the function retrieves users over a network, `fetchActiveUsers(orgId)` would be a fitting refinement, Your Majesty. As an adjacent safeguard, document precisely what “active” means.

</details>

## Ego Sword — ego-sword

Self **I** · user address **rookie**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-ego-sword.svg" alt="Ego Sword — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> Keep `getActiveUsers(orgId)`, rookie. **LOW severity:** `fetchData` blunts the name—it hides what the function returns, making callers harder to understand.
>
> Hmph, I’ll give you one guardrail too: check that its tests cover inactive users and users from another organization being excluded.

</details>

## Heavenly Demon — heavenly-demon

Self **this master** · user address **apprentice**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-heavenly-demon.svg" alt="Heavenly Demon — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> **This master’s choice: keep `getActiveUsers(orgId)`, apprentice.** It names the result and scope; `fetchData` shrouds both in fog.
>
> Tsk, this master reluctantly concedes one alternative: if network retrieval matters to callers, `fetchActiveUsers(orgId)` makes that flow explicit.
>
> One guard for this technique: verify that inactive users and users from other organizations are excluded.

</details>

## Right Hand — right-hand

Self **I** · user address **Boss**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-right-hand.svg" alt="Right Hand — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> Understood, Boss. **My choice: keep `getActiveUsers(orgId)`**—it tells the family exactly what comes back.
>
> **LOW severity:** `fetchData` obscures the purpose, making call sites harder to understand.
>
> If it performs a network request, consider `fetchActiveUsers(orgId)`; check a few call sites to keep the books clear.

</details>

## Record limits

<details>
<summary>Capture details and limits</summary>

| Field | Recorded value |
|---|---|
| Model / effort | `gpt-6.1-sol` / `high` |
| Client | Codex CLI `0.160.0` |
| Date | 2026-10-14 |
| Product revision | `9fde6ac` |

Real Codex replies using all seven current presets.
Each preset/language uses its first completed response, without polishing or selecting a preferred rerun.

Recorded on 2026-10-14 through the actual `tonedial test codex --preset <slug> --accept-usage` handoff and an ephemeral exec adapter.
These are dialogue-preview examples, not hook-activation or repeated-adherence measurements. Images render terminal-style transcripts and are not native UI screenshots.

[Complete input, reply and hash records](./media/readme/en/voice-examples.json)

No tool calls were observed in completed requests. Most samples compare disposable ToneDial-state and target bytes before/after. The first Korean Royal Advisor capture lacks its retained before-state snapshot, so it makes no unchanged-state claim.
Some requests failed with 429 before completion. Completed responses were never rerun to obtain different wording.

</details>

[README](../README.md) · [Usage](./USAGE.md)
