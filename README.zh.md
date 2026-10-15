# ToneDial

**给编程代理一个角色。**

选择角色，调整十二个语气轴，保存一套能在不同项目中复用的语气。

**7 个角色 · 12 个语气轴 · 5 种 CLI 语言 · 零运行时依赖**

[English](https://github.com/awesometic/tonedial/blob/main/README.md) | [한국어](https://github.com/awesometic/tonedial/blob/main/README.ko.md) | [日本語](https://github.com/awesometic/tonedial/blob/main/README.ja.md) | **简体中文** | [Español](https://github.com/awesometic/tonedial/blob/main/README.es.md)

## 先看实际回复

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/zh/voice-examples.svg" alt="Royal Advisor 和 Ego Sword 回答同一函数改名问题的实际 Codex 对话记录" width="760">

<sub>实际 Codex 回复，按终端对话形式排版。 <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/zh/voice-examples.json">输入与生成记录</a>.</sub>

**[查看全部 7 个角色 →](https://github.com/awesometic/tonedial/blob/main/docs/EXAMPLES.zh.md)**

## 开始试用

需要 **Node 24 或更高版本**和 npm。

```bash
npm install --global tonedial
tonedial init --tools none --global --lang zh
tonedial set
```

设置时会先展示文件变更并请求批准。无需连接代理即可先打开面板试用。

[连接代理](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#connecting-an-agent) · [使用临时设置试用](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate)

## 选择你的角色

| 预设 | 你 → 代理 |
| --- | --- |
| Caring Brother | 弟弟 → 可靠的哥哥 |
| Bratty Kid | 聊天对象 → 淘气小孩 |
| Eager Sycophant | 创作者 → 狂热粉丝 |
| Royal Advisor | 君王 → 忠臣 |
| Ego Sword | 新手冒险者 → 自我之剑 |
| Heavenly Demon | 徒弟 → 严厉的天魔 |
| Right Hand | 老大 → 可靠的左右手 |

```bash
tonedial use ego-sword
tonedial set verbosity=1 warmth=3
tonedial save "My Sword"
```

也可用 `tonedial create` 创建自己的角色。语气、角色、称呼、敬语形式和安全词一起保存在配置中。

## 调节语气

**十二个语气轴，各有五个级别。** 调整正式程度、简洁度、温暖、批评及角色表现强度。

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/zh/dial.svg" alt="显示当前值、所选 warmth 说明和键盘操作的 ToneDial 十二轴面板" width="760">

<sub>使用当前 CLI 渲染器生成的 80 列合成预览。 <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/zh/dial-example.json">帧生成记录</a> · <a href="https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#current-dial-example">生成方法</a>.</sub>

**↑↓** 选择语气轴 · **←→ / 1–5** 调整级别 · **Enter** 应用 · **Esc** 放弃

ToneDial 在本地将设置编译为 `TONE.md`，相同设置生成相同结果。模型由你使用的代理提供。

## 接入你的代理

**Claude Code · Codex · Antigravity IDE/Desktop** — [连接指南](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#connecting-an-agent)

通过已安装的 Codex 或 Claude Code 客户端试用一次新对话：

```bash
tonedial test codex --preset my-sword
```

- 预览使用你的服务商账号，按正常规则处理用量、费用和历史记录。
- 只改变表达风格，主机权限和批准要求保持不变。
- 模型反应各异。本工具用于娱乐，不建议用于生产工作。

## 进一步了解

[使用方法与参考](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md) · [贡献预设或修复](https://github.com/awesometic/tonedial/blob/main/CONTRIBUTING.md) · [测试](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md) · [安全](https://github.com/awesometic/tonedial/blob/main/SECURITY.md)

[代理工作指南](https://github.com/awesometic/tonedial/blob/main/AGENTS.md) · [MIT 许可证](https://github.com/awesometic/tonedial/blob/main/LICENSE) · [第三方声明](https://github.com/awesometic/tonedial/blob/main/THIRD_PARTY_NOTICES.md)
