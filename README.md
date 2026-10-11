# ToneDial

**English** | [한국어](https://github.com/awesometic/tonedial/blob/main/README.ko.md)

**A dial for your coding agent's voice.**

Choose twelve tone levels, save a preset, and turn it into `TONE.md`.
Compilation uses static behavioral anchors: no model API, no API key, and identical bytes for identical settings.
Your preset library stays in one place while connections can be global or project-specific.

> [!NOTE]
> This is an unreleased `0.1.0` candidate. npm and curl release channels are not live.
> Codex, Claude Code and Gemini CLI configuration is implemented; actual host activation, skill discovery and one-day acceptance remain unverified.

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/en/dial.png" alt="ToneDial inline preview: twelve axes, current and default levels, selected warmth hints, pending changes and apply/discard/help keys" width="760">

<sub>Current synthetic dial at 80 columns, not an agent response. No native client or user state was used. <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/en/dial-example.json">Frame provenance</a> · <a href="https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#current-dial-example">Recipe</a>.</sub>

## Try it

Requires Node 24+ and npm. From this checkout:

```bash
npm ci
npm run build
node dist/bin.js init --tools none --global
node dist/bin.js set
```

This previews changes to your normal ToneDial state before approval; it selects no agent connection.
Use [isolated candidate testing](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate) to keep trials away from your normal settings.
In the dial, use arrows or `hjkl`, type `1`–`5`, Enter to apply, Esc to discard, and `?` for help.

The npm and curl channels are not live for this unpublished `0.1.0` candidate.
After release, install the durable CLI with:

```bash
npm install --global tonedial
```

See [installation channels after release](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#installation-channels-after-release).
For this candidate, use [isolated candidate testing](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate) from the checkout.

After installing a durable candidate, start with `tonedial init` and choose the tools to connect.
Connections default globally; `--here` or `--project <path>` chooses a project, not another tone library.

```bash
tonedial use tough-love
tonedial set warmth=5 critique=5
tonedial save "My Tone"
tonedial show
tonedial export my-tone > my-tone.json
```

Five presets are bundled. Saved presets carry axes only; persona, address, register and safeword stay separate.
The interface is English or Korean.
Choose it during `init` with `--lang en` or `--lang ko`.
After setup, change it with `tonedial set language=ko`.
One English anchor set leaves the conversation language to your agent.

With an installed Claude Code or Codex client, try one fresh conversation:

```bash
tonedial test claude        # or: tonedial test codex
tonedial test codex --preset my-tone # try a bundled or user preset without saving
tonedial test claude --json # inspect a plan; launch nothing
```

The opening prompt requests dialogue only and no edits. Invocation-only controls request a preview without earlier tone hooks or automatic instructions.
Managed policy and native-client support remain independent; this is not OS-level isolation.
Normal account usage and history apply. Enter `y` after the usage notice to start; `--accept-usage` accepts usage and charges for this launch only.
The complete preview tone may be visible in process arguments; keep credentials and private material out of persona notes.

## Know the limits

- Tone is a request, not enforcement. Models may interpret, ignore or decline it, and capable models can still miss restrictive levels.
- This is for fun, not recommended for production use. Extreme settings can encourage abrasive, flattering or misleading replies.
- Red levels and `!` are advisory signals, not clamps or safety scores. Tone never changes host permissions or approval requirements.
- A safeword requests one plain answer. `reset` restores ToneDial's authored defaults; neither provides a persistent tone-off switch.
- Configuration, actual context delivery and model behavior are different evidence. `doctor` does not prove that a host activated the tone.
- The inline dial needs a visible preview at 60×24 or larger. Resize can leave older rows in scrollback; fonts and colors vary by terminal.

## Explore

| Need | Guide |
| --- | --- |
| Axes, commands, connections and recovery | [Using ToneDial](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md) |
| A fix, feature, integration or measurement | [Contributing](https://github.com/awesometic/tonedial/blob/main/CONTRIBUTING.md) |
| Automated, installed and actual-host checks | [Testing](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md) |
| Agent-assisted project rules | [AGENTS.md](https://github.com/awesometic/tonedial/blob/main/AGENTS.md) |
| Safe vulnerability reporting | [Security](https://github.com/awesometic/tonedial/blob/main/SECURITY.md) |

[MIT license](https://github.com/awesometic/tonedial/blob/main/LICENSE) · [Third-party notices](https://github.com/awesometic/tonedial/blob/main/THIRD_PARTY_NOTICES.md)
