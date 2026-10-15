# ToneDial

[English](https://github.com/awesometic/tonedial/blob/main/README.md) | [한국어](https://github.com/awesometic/tonedial/blob/main/README.ko.md) | [日本語](https://github.com/awesometic/tonedial/blob/main/README.ja.md) | **简体中文** | [Español](https://github.com/awesometic/tonedial/blob/main/README.es.md)

**调节编程代理语气的旋钮。**

调整十二个语气轴，保存预设，再编译为 `TONE.md`。
编译使用固定行为基准文：无需模型 API、无需 API 密钥，相同设置生成完全相同的字节。
预设库集中保存在一处，连接可按全局或项目范围配置。

原生集成会在配置的轮次事件中刷新语气。
Claude 和 Codex 可在回答后请求一次仅针对表达方式的修正，不会重做工具操作，也不会悄悄替换已显示的回答。
参见[刷新与有限的表达反馈](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#hook-refresh-and-bounded-style-feedback)。

> [!NOTE]
> 当前是尚未发布的 `0.1.0` 候选版，npm 和 curl 发布渠道尚未上线。
> 已实现 Codex、Claude Code 和 Antigravity IDE/Desktop 的配置功能；实际主机激活、技能发现及一天的验收测试仍未验证。

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/zh/dial.svg" alt="ToneDial 内联预览：十二个语气轴、当前值与默认值、所选 warmth 说明、待应用变更及应用、放弃、帮助按键" width="760">

<sub>使用当前渲染器生成的 80 列合成面板，并非代理回复。未使用原生客户端或用户状态。<a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/zh/dial-example.json">帧生成记录</a> · <a href="https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#current-dial-example">生成方法</a>。</sub>

## 听听角色怎么说

**Royal Advisor：**你是君王，代理是以宫廷措辞汇报的臣子。
**Ego Sword：**你是新手冒险者，代理是为了共同生存而不停唠叨的自我之剑。

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/zh/voice-examples.svg" alt="Royal Advisor 和 Ego Sword 对同一函数改名问题给出的首次实际 Codex 回复" width="760">

[七个预设的完整示例](https://github.com/awesometic/tonedial/blob/main/docs/EXAMPLES.zh.md) ·
[完整输入与回复记录](https://github.com/awesometic/tonedial/blob/main/docs/media/readme/zh/voice-examples.json)

<sub>Codex CLI 0.160.0 · gpt-6.1-sol · high 推理 · 2026-10-15。首次完成回复的原文，按终端对话形式排版。并非原生 UI 截图，也不证明钩子已激活。</sub>

## 试用

需要 Node 24 或更高版本及 npm。在此检出目录中运行：

```bash
npm ci
npm run build
node dist/bin.js init --tools none --global --lang zh
node dist/bin.js set
```

这会在批准前预览对常用 ToneDial 状态的变更，不选择任何代理连接。
如需避开常用设置，请使用[隔离候选版测试](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate)。
面板中可用方向键或 `hjkl` 移动，输入 `1`–`5` 设置级别，Enter 应用，Esc 放弃，`?` 显示帮助。

尚未发布的 `0.1.0` 候选版还没有可用的 npm 或 curl 发布渠道。
正式发布后，可安装持久 CLI：

```bash
npm install --global tonedial
```

参见[发布后的安装渠道](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#installation-channels-after-release)。
候选版请从检出目录按[隔离测试步骤](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate)试用。

安装持久候选版后，运行 `tonedial init` 并选择要连接的工具。
默认全局连接；`--here` 或 `--project <path>` 选择项目，而不是创建另一个语气库。

```bash
tonedial use ego-sword
tonedial set warmth=5 critique=5
tonedial set persona.user="维护服务，偏好直说取舍" \
  persona.agent="虚构的 SRE 专家，角色设定为有十二年经验，说话直白"
tonedial save "My Tone"
tonedial show
tonedial export my-tone > my-tone.json
```

内置七个角色配置：Caring Brother、Bratty Kid、Eager Sycophant、Royal Advisor、Ego Sword、Heavenly Demon 和 Right Hand。
每个配置都提供称呼、用户角色、虚构代理角色及敬语形式的默认值。
内置配置和保存的自定义配置都将语气轴、人设、称呼、敬语形式和安全词一起保存。
`use` 恢复整套设置；旧版仅含语气轴的预设保留当前的其他设置。
Tough Love 和 Terse Operator 已从菜单中移除，但旧标识名和保存副本仍可使用。
提高 `playfulness` 会请求更频繁、夸张的角色表达和黑话。
这些表达不会被过滤；CLI 会举例提示哪些措辞可能显得无礼或粗暴。
`tonedial create` 引导设置名称、独立标识名、语气设置及十二轴面板。
`show` 显示当前设置；与保存配置不同时，会给出保存命令。
`show <slug>` 则预览已保存的配置。
`persona.user` 和 `persona.agent` 是可选描述，各自最多 200 个 Unicode 码点；传入空值可清除。
代理描述是虚构角色设定，不验证资历，也不授予权限。
`set persona.agent="..."` 会立即添加或更改当前角色，并保留语气轴；使用 `save` 更新当前配置。
界面支持英语（`en`）、韩语（`ko`）、日语（`ja`）、简体中文（`zh`）和西班牙语（`es`）。
在 `init` 中通过 `--lang CODE` 选择；设置后可用 `tonedial set language=zh` 更改。
行为基准文只有一套英文版本，实际对话语言由代理决定。

安装 Claude Code 或 Codex 客户端后，可开启一次新对话试用：

```bash
tonedial test claude        # 或 tonedial test codex
tonedial test codex --preset my-tone # 试用预设，不修改保存设置
tonedial test claude --json # 仅查看计划，不启动客户端
```

开场提示要求仅对话、不编辑。调用选项请求跳过之前的语气钩子与自动指令。
托管策略和原生客户端支持情况独立适用；这不是操作系统级隔离。
账号用量及历史记录按正常规则处理。查看用量提示后输入 `y` 开始；`--accept-usage` 仅接受本次启动的用量与费用。
完整预览语气可能出现在进程参数中，请勿在角色描述或备注中加入凭据和私人信息。

## 了解限制

- 语气是请求，不是强制。模型可能自行解读、忽略或拒绝，即使能力较强的模型也可能偏离严格级别。
- 本工具用于娱乐，不建议用于生产工作。极端设置可能促成冒犯、奉承或误导性的回复。
- 红色级别及 `!` 是提示信号，不是限制或安全评分。语气不会更改主机权限或批准要求。
- 安全词请求一次平实回答。`reset` 恢复 ToneDial 的默认语气轴；两者都不是永久关闭语气的开关。
- 配置、实际上下文注入和模型行为是不同证据。`doctor` 不证明主机已激活语气。
- 内联面板需要至少 60×24 且能显示预览。调整尺寸可能使旧行留在滚动历史中；字体和颜色取决于终端。

## 深入了解

| 需求 | 指南 |
| --- | --- |
| 语气轴、命令、连接和恢复 | [使用 ToneDial](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md) |
| 修复、功能、集成或测量贡献 | [贡献指南](https://github.com/awesometic/tonedial/blob/main/CONTRIBUTING.md) |
| 自动、安装后及实际主机检查 | [测试](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md) |
| 代理辅助工作的项目规则 | [AGENTS.md](https://github.com/awesometic/tonedial/blob/main/AGENTS.md) |
| 安全报告漏洞 | [安全说明](https://github.com/awesometic/tonedial/blob/main/SECURITY.md) |

[MIT 许可证](https://github.com/awesometic/tonedial/blob/main/LICENSE) · [第三方声明](https://github.com/awesometic/tonedial/blob/main/THIRD_PARTY_NOTICES.md)
