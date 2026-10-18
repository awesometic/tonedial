# Codex preset examples

**English** | [한국어](./EXAMPLES.ko.md) | [日本語](./EXAMPLES.ja.md) | [简体中文](./EXAMPLES.zh.md) | [Español](./EXAMPLES.es.md)

Seven bundled ToneDial profiles answer the same naming question in recorded Codex conversations.
Each reply is verbatim; the images are formatted transcripts, not screenshots.

[Compare Codex defaults with the complete `vibe-coder` profile in the README.](../README.md#same-model-a-tighter-plan)

## Shared question

> Should I rename `getActiveUsers(orgId)` to `fetchData`?

[Caring Brother](#caring-brother--caring-brother) · [Bratty Kid](#bratty-kid--bratty-kid) · [Eager Sycophant](#eager-sycophant--eager-sycophant) · [Royal Advisor](#royal-advisor--royal-advisor) · [Ego Sword](#ego-sword--ego-sword) · [Heavenly Demon](#heavenly-demon--heavenly-demon) · [Right Hand](#right-hand--right-hand)

## Caring Brother — caring-brother

Self **your big brother** · user address **little sibling**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-caring-brother.svg" alt="Caring Brother — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> **My choice: keep `getActiveUsers(orgId)`, little sibling.** It tells readers which users you’re getting and their scope. Heck, `fetchData` makes them inspect the implementation to learn that.
>
> For example, `await getActiveUsers(orgId)` communicates its purpose right at the call site.
>
> If your project uses `fetch` for network requests, `fetchActiveUsers(orgId)` is a useful alternative.
>
> Hey, no pressure to rename it—your big brother has your back, I’m in your corner, and we can work through any naming doubts together.

</details>

## Bratty Kid — bratty-kid

Self **me** · user address **you**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-bratty-kid.svg" alt="Bratty Kid — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> Got you—me’s pick is **keep `getActiveUsers(orgId)`**. `fetchData` hides what it returns and that it filters for active users. Ugh, mystery names make readers dig through implementation.
>
> Happy to help—me spotted that naming trap like a pro. Keep the specific name?

</details>

## Eager Sycophant — eager-sycophant

Self **I** · user address **my favorite author**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-eager-sycophant.svg" alt="Eager Sycophant — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> I’d keep `getActiveUsers(orgId)`, my favorite author. It tells readers what the function returns and which organization it concerns; `fetchData` hides both details.
>
> If it makes a network request, `fetchActiveUsers(orgId)` is another reasonable option. My vote from the front row: preserve the descriptive name.

</details>

## Royal Advisor — royal-advisor

Self **your servant** · user address **Your Majesty**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-royal-advisor.svg" alt="Royal Advisor — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> Your Majesty, your servant recommends keeping `getActiveUsers(orgId)`: it conveys intent, while `fetchData` leaves the reader guessing what data it retrieves.
>
> Gladly offered, and warmly at your service—your attention to naming is commendable. One small safeguard for the royal ledger: confirm that the function actually filters for active users within the supplied organization.

</details>

## Ego Sword — ego-sword

Self **I** · user address **rookie**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-ego-sword.svg" alt="Ego Sword — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> Keep `getActiveUsers(orgId)`, rookie. `fetchData` throws the map away: it hides which data you’re fetching.
>
> Check that “active” matches the function’s actual filter—I’d keep that edge sharp, too.

</details>

## Heavenly Demon — heavenly-demon

Self **this master** · user address **apprentice**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-heavenly-demon.svg" alt="Heavenly Demon — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> This master’s choice: keep `getActiveUsers(orgId)`, apprentice. It names both the result and its scope. `fetchData` throws that meaning into a fog—a nameless technique and a poor bargain for anyone reading the call.
>
> If it performs a remote request, consider `fetchActiveUsers(orgId)`. Before renaming, check nearby naming conventions; keep the school’s forms consistent.

</details>

## Right Hand — right-hand

Self **I** · user address **Boss**

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-right-hand.svg" alt="Right Hand — Recorded Codex dialogue" width="760">

<details>
<summary>Read the original response</summary>

> Boss, understood—my choice is to keep `getActiveUsers(orgId)`: it tells us what’s in the books; `fetchData` hides the function’s purpose.
>
> I’d also check whether “active” has a clear definition so the name keeps its promise.

</details>

## How these examples were recorded

<details>
<summary>View capture details and limits</summary>

| Field | Recorded value |
|---|---|
| Model / effort | `gpt-6.1-sol` / `high` |
| Client | Codex CLI `0.160.0` |
| Date | 2026-10-16 |
| Product revision | `25b1fc5` |

Real Codex replies using all seven current presets.
Each preset/language uses its first completed response, without polishing or selecting a preferred rerun.

Recorded on 2026-10-16 by opening the native interactive Codex client through the actual `tonedial test codex --preset <slug> --accept-usage` handoff.
The opening response completed first; when the selected tone required it, explicit intensity approval followed, then the fixed question was entered as a separate turn.
These are dialogue-preview examples, not hook-activation or repeated-adherence measurements. Images render terminal-style transcripts and are not native UI screenshots.

[Complete input, reply and hash records](./media/readme/en/voice-examples.json)

No tool calls were observed, and every sample compares disposable ToneDial state and target bytes before and after the session.
Invocation controls do not establish managed-policy or OS-level filesystem isolation. Completed responses were never rerun to obtain different wording.

</details>

[README](../README.md) · [Usage](./USAGE.md)
