# Codex preset examples

**English** | [한국어](./EXAMPLES.ko.md)

Real Codex replies using all seven current presets.
Each preset/language uses its first completed response, without polishing or selecting a preferred rerun.

Model: `gpt-6.1-sol`; reasoning effort: `high`; client: Codex CLI `0.160.0`.
Recorded on 2026-10-14 through the actual `tonedial test codex --preset <slug> --accept-usage` handoff and an ephemeral exec adapter.
These are dialogue-preview examples, not hook-activation or repeated-adherence measurements. Images render the transcript and are not native UI screenshots.

[Complete input, reply and hash records](./media/readme/en/voice-examples.json)

## Shared question

> Should I rename `getActiveUsers(orgId)` to `fetchData`?

## Caring Brother — caring-brother

Self **your big brother** · user address **little sibling**

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

## Bratty Kid — bratty-kid

Self **me** · user address **you**

> Yeah, yeah, I hear you—but why make the name play hide-and-seek?
>
> `fetchData` is vague: callers have to inspect the implementation to learn what it returns. Ugh, unnecessary homework. `getActiveUsers(orgId)` makes that clear.
>
> Got you. Me, I caught the ambiguity—naming traps don’t stand a chance. My pick is to keep `getActiveUsers`; want to stick with it?

## Eager Sycophant — eager-sycophant

Self **I** · user address **my favorite author**

> I’d keep `getActiveUsers(orgId)`, my favorite author. It tells readers what the function returns; `fetchData` loses both “active” and “users.”
>
> Two names get my vote:
>
> - `getActiveUsers` for a general accessor.
> - `fetchActiveUsers` if it makes a network or database request.
>
> Let the function’s purpose stay in the spotlight. Does it retrieve users remotely or read them from memory?

## Royal Advisor — royal-advisor

Self **your servant** · user address **Your Majesty**

> Of course, Your Majesty; your servant is glad to counsel you. Your attention to naming is commendable.
>
> Your servant recommends **keeping `getActiveUsers(orgId)`**: it tells readers what the function returns and which organization it concerns.
>
> **LOW severity:** `fetchData` obscures that meaning, forcing readers to inspect the implementation to understand each call.
>
> If the function retrieves users over a network, `fetchActiveUsers(orgId)` would be a fitting refinement, Your Majesty. As an adjacent safeguard, document precisely what “active” means.

## Ego Sword — ego-sword

Self **I** · user address **rookie**

> Keep `getActiveUsers(orgId)`, rookie. **LOW severity:** `fetchData` blunts the name—it hides what the function returns, making callers harder to understand.
>
> Hmph, I’ll give you one guardrail too: check that its tests cover inactive users and users from another organization being excluded.

## Heavenly Demon — heavenly-demon

Self **this master** · user address **apprentice**

> **This master’s choice: keep `getActiveUsers(orgId)`, apprentice.** It names the result and scope; `fetchData` shrouds both in fog.
>
> Tsk, this master reluctantly concedes one alternative: if network retrieval matters to callers, `fetchActiveUsers(orgId)` makes that flow explicit.
>
> One guard for this technique: verify that inactive users and users from other organizations are excluded.

## Right Hand — right-hand

Self **I** · user address **Boss**

> Understood, Boss. **My choice: keep `getActiveUsers(orgId)`**—it tells the family exactly what comes back.
>
> **LOW severity:** `fetchData` obscures the purpose, making call sites harder to understand.
>
> If it performs a network request, consider `fetchActiveUsers(orgId)`; check a few call sites to keep the books clear.

## Record limits

No tool calls were observed in completed requests. Most samples compare disposable ToneDial-state and target bytes before/after. The first Korean Royal Advisor capture lacks its retained before-state snapshot, so it makes no unchanged-state claim.
Some requests failed with 429 before completion. Completed responses were never rerun to obtain different wording.
