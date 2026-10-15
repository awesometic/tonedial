# ToneDial

[English](https://github.com/awesometic/tonedial/blob/main/README.md) | [한국어](https://github.com/awesometic/tonedial/blob/main/README.ko.md) | **日本語** | [简体中文](https://github.com/awesometic/tonedial/blob/main/README.zh.md) | [Español](https://github.com/awesometic/tonedial/blob/main/README.es.md)

**コーディングエージェントの口調を調整するダイヤル。**

12個の軸を調整し、プリセットを保存して `TONE.md` に変換します。
コンパイルには固定の行動基準文を使います。モデルAPIもAPIキーも不要で、同じ設定からは同じバイト列を生成します。
プリセットは1か所で管理し、接続範囲は全プロジェクト共通かプロジェクト単位で選べます。

ネイティブ連携は、設定されたターンイベントで口調を再読み込みします。
ClaudeとCodexは回答後に一度だけ、表現の修正を要求できます。ツール操作を繰り返したり、表示済みの回答を黙って置き換えたりはしません。
詳しくは[再読み込みと限定的な表現フィードバック](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#hook-refresh-and-bounded-style-feedback)を参照してください。

> [!NOTE]
> 現在は未公開の `0.1.0` 候補版です。npmとcurlの配布経路はまだ利用できません。
> Codex、Claude Code、Antigravity IDE/Desktop用の設定処理は実装済みですが、実際のホストでの有効化、スキル検出、1日間の受け入れ試験は未検証です。

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ja/dial.svg" alt="ToneDialのインラインプレビュー：12個の軸、現在値と既定値、選択したwarmthの説明、未適用の変更と適用・破棄・ヘルプのキー" width="760">

<sub>現在のレンダラーによる80列の合成ダイヤルです。エージェントの応答ではありません。ネイティブクライアントや利用者の状態は使っていません。<a href="https://github.com/awesometic/tonedial/blob/main/docs/media/readme/ja/dial-example.json">フレームの生成記録</a> · <a href="https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#current-dial-example">生成手順</a>。</sub>

## キャラクターの口調を聞く

**Royal Advisor:** あなたは君主、エージェントは宮廷の言葉で報告する臣下です。
**Ego Sword:** あなたは駆け出しの冒険者、エージェントはともに生き延びるため小言を言う剣です。

<img src="https://raw.githubusercontent.com/awesometic/tonedial/main/docs/media/readme/ja/voice-examples.svg" alt="同じ関数名変更の質問に答えたRoyal AdvisorとEgo Swordの最初の実際のCodex応答" width="760">

[7個のプリセットの全例](https://github.com/awesometic/tonedial/blob/main/docs/EXAMPLES.ja.md) ·
[入力と応答の完全な記録](https://github.com/awesometic/tonedial/blob/main/docs/media/readme/ja/voice-examples.json)

<sub>Codex CLI 0.160.0 · gpt-6.1-sol · high推論 · 2026-10-15。最初に完了した応答の原文をターミナル風の対話として表示しています。ネイティブUIの画像でも、フック有効化の証拠でもありません。</sub>

## 試してみる

Node 24以降とnpmが必要です。このチェックアウトで実行します。

```bash
npm ci
npm run build
node dist/bin.js init --tools none --global --lang ja
node dist/bin.js set
```

通常のToneDial状態に対する変更を承認前に表示します。エージェントの接続は選択しません。
通常の設定を使わずに試す場合は[候補版の隔離テスト](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate)を使ってください。
ダイヤルは矢印キーか `hjkl` で操作し、`1`–`5` で値を設定、Enterで適用、Escで破棄、`?` でヘルプを表示します。

未公開の `0.1.0` 候補版ではnpmとcurlの配布経路はまだ利用できません。
公開後は永続的なCLIをインストールできます。

```bash
npm install --global tonedial
```

[公開後のインストール経路](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#installation-channels-after-release)を参照してください。
候補版はチェックアウトから[隔離テスト](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md#isolated-candidate)で試してください。

永続的な候補版をインストールしたら、`tonedial init` で接続するツールを選びます。
接続は既定でグローバルです。`--here` や `--project <path>` は別のプリセット庫ではなく、接続先のプロジェクトを選びます。

```bash
tonedial use ego-sword
tonedial set warmth=5 critique=5
tonedial set persona.user="サービスを保守しており、率直なトレードオフ説明を好む" \
  persona.agent="架空のSRE専門家。経験12年という役柄で、率直に話す"
tonedial save "My Tone"
tonedial show
tonedial export my-tone > my-tone.json
```

Caring Brother、Bratty Kid、Eager Sycophant、Royal Advisor、Ego Sword、Heavenly Demon、Right Handの7個のキャラクタープロファイルを同梱しています。
各プロファイルに呼称、利用者の役割、架空のエージェント役、敬語区分の既定値があります。
組み込みとカスタムの両プロファイルが、軸、ペルソナ、呼称、敬語区分、合言葉をまとめて保存します。
`use` は設定全体を復元します。旧形式の軸のみのプリセットは、現在のその他の設定を保持します。
Tough LoveとTerse Operatorはメニューから外しましたが、旧スラッグと保存済みコピーは引き続き使えます。
`playfulness` を上げるほど、役柄の言い回しや隠語を頻繁に、大げさに使うよう要求します。
こうした表現は除外しません。無礼・粗暴に聞こえる可能性のある例をCLIで案内します。
`tonedial create` は名前、別のスラッグ、口調設定、12軸ダイヤルを順に案内します。
`show` は現在の設定を表示し、保存プロファイルと異なる場合は保存コマンドを示します。
`show <slug>` は保存済みプロファイルのプレビューです。
`persona.user` と `persona.agent` は任意で、それぞれ200 Unicodeコードポイントまで入力できます。空の値で消去します。
エージェントの説明は架空の役柄であり、資格の証明や権限の付与にはなりません。
`set persona.agent="..."` で現在の役割をすぐに変えられます。軸は保持し、`save` で現在のプロファイルに保存します。
表示言語は英語（`en`）、韓国語（`ko`）、日本語（`ja`）、中国語簡体字（`zh`）、スペイン語（`es`）です。
`init` の `--lang CODE` で選択し、設定後は `tonedial set language=ja` で変更します。
行動基準文は英語1組だけを使い、会話の言語はエージェントに任せます。

Claude CodeかCodexをインストールしていれば、新しい会話で試せます。

```bash
tonedial test claude        # または tonedial test codex
tonedial test codex --preset my-tone # 保存せずプリセットを試す
tonedial test claude --json # 計画だけを確認し、起動しない
```

開始プロンプトは会話のみを求め、編集を禁止します。起動オプションで既存の口調フックや自動指示の省略を要求します。
管理ポリシーとネイティブクライアントの対応は別であり、OSレベルの隔離ではありません。
通常のアカウント使用量と履歴の扱いが適用されます。使用量の案内後に `y` で開始します。`--accept-usage` は今回の起動の使用量と料金にのみ同意します。
プレビューの口調全文がプロセス引数に見える場合があります。資格情報や個人情報を役割説明やメモに入れないでください。

## 制約を知る

- 口調は要求であり、強制ではありません。モデルは独自に解釈、無視、拒否する場合があり、高性能なモデルでも厳密なレベルを外すことがあります。
- 娯楽用で、実務利用は推奨しません。極端な設定は攻撃的、お世辞が多い、誤解を招く回答につながる場合があります。
- 赤いレベルと `!` は参考の注意表示で、制限や安全性スコアではありません。ホストの権限や承認要件は変えません。
- 合言葉は一度だけ平易な回答を求めます。`reset` はToneDialの既定値を復元します。どちらも口調の恒久的なオフスイッチではありません。
- 設定、実際のコンテキスト配信、モデルの振る舞いは別の証拠です。`doctor` はホストで口調が有効になったことを証明しません。
- インラインダイヤルは60×24以上で見えるプレビューが必要です。リサイズで古い行がスクロール履歴に残る場合があり、フォントと色はターミナルに依存します。

## 詳細を調べる

| 目的 | ガイド |
| --- | --- |
| 軸、コマンド、接続、復旧 | [ToneDialの使い方](https://github.com/awesometic/tonedial/blob/main/docs/USAGE.md) |
| 修正、機能、連携、測定の提案 | [貢献ガイド](https://github.com/awesometic/tonedial/blob/main/CONTRIBUTING.md) |
| 自動・インストール・実ホストの検証 | [テスト](https://github.com/awesometic/tonedial/blob/main/docs/TESTING.md) |
| エージェント支援時の作業規則 | [AGENTS.md](https://github.com/awesometic/tonedial/blob/main/AGENTS.md) |
| 脆弱性の安全な報告 | [セキュリティ](https://github.com/awesometic/tonedial/blob/main/SECURITY.md) |

[MITライセンス](https://github.com/awesometic/tonedial/blob/main/LICENSE) · [第三者の権利表示](https://github.com/awesometic/tonedial/blob/main/THIRD_PARTY_NOTICES.md)
