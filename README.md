# imgdec

Claude Code に添付した画像（ドラッグ&ドロップ・貼り付け）を、Claude に渡る前に小さくしてトークンを節約する mod です。

画面全体のスクリーンショットなら、約 3,000 トークンが約 800 トークンになります（長辺 1024px のとき）。

## インストール

1. ImageMagick を入れる（macOS は無くても動きますが、余白カットが使えません）

   ```bash
   brew install imagemagick      # macOS
   sudo apt install imagemagick  # Linux
   ```

2. mod を入れる

   ```bash
   claude plugin marketplace add nakamura-shuta/claude-mod-imgdec
   claude plugin install imgdec@claude-mod-imgdec
   ```

3. Claude Code を起動し直す（起動中なら `/reload-plugins`）

private リポジトリなので、読める権限と github.com の git 認証が必要です。対応は macOS と Linux です（Windows は対象外）。

## 使い方

入れたら、あとはいつもどおり画像を添付して送るだけです。小さくしたときは、会話に結果が1行出ます。

```text
imgdec: 2000×1177 → 1024×603 (resize, ~3,096 → 814 tokens)
```

設定を変えるときは `/imgdec` を使います。設定はセッションをまたいで残ります。

| コマンド | 動き |
|---|---|
| `/imgdec` | 今の設定と、直近の結果を表示 |
| `/imgdec off` | 止める（画像をそのまま渡す） |
| `/imgdec on` | 再開する |
| `/imgdec max 1280` | 長辺の上限を変える（256〜2000px。既定は 1024） |

細かい文字が読み取られないときは、上限を上げる（1280〜1568）か、`/imgdec off` にして送り直してください。

## 何をするか

1. 周囲の単色の余白を切り落とす（ImageMagick があるとき。文字の大きさは変わらない）
2. それでも長辺が上限を超えていれば縮小する
3. 小さくできた画像は、一時フォルダに保存したファイルを Claude に読ませる（元の添付は会話から外す）

- 小さくならない画像と GIF は、何もせずそのまま渡します。途中で失敗したときも同じです
- 保存先はユーザー専用の一時フォルダ（`$TMPDIR/claude-imgdec.XXXXXX/`）です。1日より古いものは、次に画像を送ったときに消します
- 画像のトークン数は縦横のピクセル数で決まるので、減らすのはピクセル数だけです（圧縮率や色数は変えません）

## 確認済みの範囲

- macOS: ドラッグ&ドロップ、クリップボードからの貼り付け、余白カット、縮小、`/imgdec` の各コマンド
- Linux: 使うコマンド（ImageMagick 6 など）を Ubuntu 24.04 で試しただけで、Claude Code 上では未確認
- 複数枚を同時に添付したときは未確認（添付の順番と会話内の画像の順番が同じ前提なので、ずれると別の画像を外す恐れがあります）
