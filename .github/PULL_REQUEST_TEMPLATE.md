<!-- Keep one coherent purpose per pull request. Measurements are welcome when their
     fixed inputs and evidence are included. -->

## What this changes

<!-- One or two sentences. What is different afterwards. -->

## Why

<!-- What went wrong, or what was missing. If a measurement drove this, link it. -->

## Verification record

<!-- List commands and outcomes in the matching section. A skipped check is not a pass.
     Documentation-only changes can use focused link, example or issue-form checks and
     should say why the runtime suite is not applicable. Runtime/build changes should
     report the relevant full suite against the integrated change. -->

### Passed

<!-- Include the command and the state or commit it checked. Write "None" when empty. -->

- _Replace this line with commands and outcomes._

### Failed

<!-- Include the command, failure and whether it blocks this PR. Write "None" when empty. -->

- _Replace this line with commands and outcomes, or write "None"._

### Not run or unavailable

<!-- Name the check and why it was not run or unavailable. Write "None" when empty. -->

- _Replace this line with checks and reasons, or write "None"._

### Evidence boundaries

<!-- Keep these claims separate; "not observed" and "not applicable" are valid entries.
     Do not paste personal
     configuration, credentials, provider history, or unredacted host output. -->

- Generated configuration or artifact:
- Host trust or activation:
- Delivered context:
- Model adherence:

## Review checklist

- [ ] Verification matches the change: focused checks with a reason for documentation-only work, or the relevant full suite for runtime/build work
- [ ] Changed behaviour has protection against realistic regressions, or I explained why no new test is needed
- [ ] No existing test was weakened to pass (see [testing guidance](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#automated-checks))
- [ ] I reviewed the complete diff and take responsibility for the change, including any AI-assisted work
- [ ] Examples, logs and screenshots are synthetic or redacted; no personal configuration, credentials, provider history or generated local links are included
