# imgdec

Claude Code に添付した画像（ドラッグ&ドロップ・貼り付け）を、Claude に渡る前に小さくしてトークンを減らす mod です。

手元の2枚では、画像1枚ぶんのコンテキストの増加が 51〜69% 減りました（長辺 1024px のとき）。

## インストール

```bash
brew install imagemagick      # Linux は sudo apt install imagemagick

claude plugin marketplace add nakamura-shuta/claude-mod-imgdec
claude plugin install imgdec@claude-mod-imgdec
```

入れたあとは Claude Code を起動し直します（起動中なら `/reload-plugins`）。

対応は macOS と Linux です。macOS は ImageMagick が無くても縮小だけは動きます。

## 使い方

いつもどおり画像を添付して送るだけです。小さくしたときは、会話に結果が1行出ます。

```text
imgdec: 2000×1177 → 1024×603 (resize, ~3,096 → 814 tokens)
```

| コマンド | 動き |
|---|---|
| `/imgdec` | 今の設定と、直近の結果を表示 |
| `/imgdec off` / `on` | 止める / 再開する |
| `/imgdec max 1280` | 長辺の上限を変える（256〜2000px。既定は 1024） |
| `/imgdec mode resend` / `read` | 渡し方を変える（既定は read） |

細かい文字が読み取られないときは、上限を上げるか、`/imgdec off` にして送り直してください。

## 仕組み

1. 周囲の単色の余白を切り落とす（文字の大きさは変わらない）
2. それでも長辺が上限を超えていれば縮小する
3. 小さくした画像を一時フォルダに保存し、元の添付の代わりに Claude に渡す

小さくならない画像と GIF、途中で失敗した画像は、そのまま渡します。

渡し方は3つあります。

| 渡し方 | 操作 | 追加のリクエスト |
|---|---|---|
| Read（既定） | 添付して Enter | 1回（Claude が Read を呼ぶ） |
| `@` で指定 | `@path/to/image.png` と書いて送る | なし |
| 再送信（試作） | 添付して Enter、入力欄に `@…` が入ったらもう一度 Enter | なし |

`@` と再送信は ImageMagick が必要です。

## 計測結果

画像1枚ぶんのコンテキストの増加を、API の `usage` で測った結果です（Fable 5.2、上限 1024px）。

| 渡し方 | 図（1672×941、余白あり） | 単純な絵（2200×1400） |
|---|---|---|
| 元のまま | 2,164 | 3,476 |
| Read | 1,059（−51%） | 1,320（−62%） |
| `@` で指定 | 849（−61%） | 1,071（−69%） |

## 確認済みの範囲

- macOS: ドラッグ&ドロップ、貼り付け、複数枚の添付、`/imgdec` の各コマンド
- macOS（1枚で試しただけ）: `@` で指定した画像、再送信
- Linux: 使うコマンドを Ubuntu 24.04 で試しただけで、Claude Code 上では未確認

## 開発

```bash
claude plugin test imgdec       # テスト
claude plugin validate imgdec   # mod として読み込めるかの検査
```

## ライセンス

MIT
