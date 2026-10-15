# ToneDial

**Give your coding agent a character.**

Pick a character, tune twelve dials, and save a voice to use across projects.

**7 characters · 12 tone axes · 5 CLI languages · Zero runtime dependencies**

**English** | [한국어](https://github.com/awesometic/tonedial/blob/main/README.ko.md) | [日本語](https://github.com/awesometic/tonedial/blob/main/README.ja.md) | [简体中文](https://github.com/awesometic/tonedial/blob/main/README.zh.md) | [Español](https://github.com/awesometic/tonedial/blob/main/README.es.md)

## Hear it first

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/voice-examples.svg" alt="Royal Advisor and Ego Sword answer the same function-renaming question in recorded Codex conversations" width="760">

<sub>Recorded Codex replies, formatted as terminal dialogue. <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/en/voice-examples.json">Inputs & provenance</a>.</sub>

**[See all 7 characters →](https://github.com/awesometic/tonedial/blob/main/docs/EXAMPLES.md)**

## Try it

Requires **Node 24+** and npm.

```bash
npm install --global tonedial
tonedial init --tools none --global --lang en
tonedial set
```

Setup previews file changes for approval. This opens the dial without connecting an agent.

[Connect your agent](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#connecting-an-agent) · [Try with disposable settings](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate)

## Pick your character

| Preset | You → agent |
| --- | --- |
| Caring Brother | Little sibling → big brother |
| Bratty Kid | Conversation partner → cheeky kid |
| Eager Sycophant | Creator → overexcited fan |
| Royal Advisor | Monarch → loyal subject |
| Ego Sword | Rookie → sentient sword |
| Heavenly Demon | Apprentice → stern martial master |
| Right Hand | Boss → trusted consigliere |

```bash
tonedial use ego-sword
tonedial set verbosity=1 warmth=3
tonedial save "My Sword"
```

Use `tonedial create` to build your own. Profiles keep tone, roles, address forms, register and safeword together.

## Turn the dials

**Twelve axes, five levels each.** Choose how formal, brief, warm, critical or theatrical your agent sounds.

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/dial.png" alt="ToneDial's twelve-axis inline dial with current levels, selected warmth hints and keyboard controls" width="760">

<sub>80-column synthetic preview from the current CLI renderer. <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/en/dial-example.json">Frame provenance</a> · <a href="https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#current-dial-example">Recipe</a>.</sub>

**↑↓** choose an axis · **←→ / 1–5** set its level · **Enter** apply · **Esc** discard

ToneDial compiles your settings into `TONE.md` locally and deterministically. Your agent supplies the model.

## Bring your agent

**Claude Code · Codex · Antigravity IDE/Desktop** — [connection guide](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#connecting-an-agent)

Try a fresh conversation through an installed Codex or Claude Code client:

```bash
tonedial test codex --preset my-sword
```

- Previews use your provider account; normal usage, charges and history apply.
- Tone changes style. Host permissions and approval requirements stay in place.
- Model behavior varies. This is for fun, not recommended for production use.

## Go further

[Usage & reference](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md) · [Contribute a preset or fix](https://github.com/awesometic/tonedial/blob/main/CONTRIBUTING.md) · [Testing](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md) · [Security](https://github.com/awesometic/tonedial/blob/main/SECURITY.md)

[Agent guide](https://github.com/awesometic/tonedial/blob/main/AGENTS.md) · [MIT license](https://github.com/awesometic/tonedial/blob/main/LICENSE) · [Third-party notices](https://github.com/awesometic/tonedial/blob/main/THIRD_PARTY_NOTICES.md)
