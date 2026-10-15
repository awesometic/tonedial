# ToneDial

**コーディングエージェントにキャラクターを。**

キャラクターを選び、12個のダイヤルで口調を調整。保存した声をプロジェクトをまたいで使えます。

**7キャラクター · 12の口調軸 · CLIは5言語 · 実行時の依存パッケージなし**

[English](https://github.com/awesometic/tonedial/blob/main/README.md) | [한국어](https://github.com/awesometic/tonedial/blob/main/README.ko.md) | **日本語** | [简体中文](https://github.com/awesometic/tonedial/blob/main/README.zh.md) | [Español](https://github.com/awesometic/tonedial/blob/main/README.es.md)

## まずは応答から

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ja/voice-examples.svg" alt="同じ関数名変更の質問に答えるRoyal AdvisorとEgo Swordの実際のCodex対話記録" width="760">

<sub>実際のCodex応答をターミナル風の対話として表示しています。 <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/ja/voice-examples.json">入力と生成記録</a>.</sub>

**[7キャラクターすべてを見る →](https://github.com/awesometic/tonedial/blob/main/docs/EXAMPLES.ja.md)**

## 試してみる

**Node 24以降**とnpmが必要です。

```bash
npm install --global tonedial
tonedial init --tools none --global --lang ja
tonedial set
```

設定時にファイル変更を表示し、承認を求めます。エージェントに接続せず、まずダイヤルを試せます。

[エージェントを接続する](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#connecting-an-agent) · [一時設定で試す](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate)

## キャラクターを選ぶ

| プリセット | あなた → エージェント |
| --- | --- |
| Caring Brother | 弟や妹 → 頼れる兄 |
| Bratty Kid | 話し相手 → 生意気な子供 |
| Eager Sycophant | 創作者 → 熱狂的ファン |
| Royal Advisor | 君主 → 忠実な臣下 |
| Ego Sword | 駆け出しの冒険者 → 自我を持つ剣 |
| Heavenly Demon | 弟子 → 厳格な天魔 |
| Right Hand | 親分 → 信頼できる右腕 |

```bash
tonedial use ego-sword
tonedial set verbosity=1 warmth=3
tonedial save "My Sword"
```

`tonedial create` で自分のキャラクターも作れます。口調、役割、呼称、敬語区分、合言葉を1つのプロファイルに保存します。

## ダイヤルを回す

**12の軸を、それぞれ5段階で。** 格式、簡潔さ、温かさ、批判、役柄の強さを調整します。

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ja/dial.svg" alt="現在値、選択したwarmthの説明、キー操作を示すToneDialの12軸ダイヤル" width="760">

<sub>現在のCLIレンダラーで生成した80列の合成プレビューです。 <a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/ja/dial-example.json">フレームの生成記録</a> · <a href="https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#current-dial-example">生成手順</a>.</sub>

**↑↓** 軸を選択 · **←→ / 1–5** 値を変更 · **Enter** 適用 · **Esc** 破棄

ToneDialは設定をローカルで `TONE.md` にコンパイルします。同じ設定からは同じ結果を生成し、モデルは利用中のエージェントが提供します。

## エージェントと使う

**Claude Code · Codex · Antigravity IDE/Desktop** — [接続ガイド](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#connecting-an-agent)

インストール済みのCodexかClaude Codeで、新しい会話を試せます。

```bash
tonedial test codex --preset my-sword
```

- プレビューは利用者のプロバイダーアカウントを使い、通常の使用量・料金・履歴の扱いが適用されます。
- 変わるのは話し方です。ホストの権限と承認要件はそのままです。
- 反応はモデルによって異なります。娯楽用で、実務利用は推奨しません。

## さらに詳しく

[使い方とリファレンス](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md) · [プリセットや修正を提案](https://github.com/awesometic/tonedial/blob/main/CONTRIBUTING.md) · [テスト](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md) · [セキュリティ](https://github.com/awesometic/tonedial/blob/main/SECURITY.md)

[エージェント作業ガイド](https://github.com/awesometic/tonedial/blob/main/AGENTS.md) · [MITライセンス](https://github.com/awesometic/tonedial/blob/main/LICENSE) · [第三者の権利表示](https://github.com/awesometic/tonedial/blob/main/THIRD_PARTY_NOTICES.md)
