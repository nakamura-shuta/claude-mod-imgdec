# imgdec

Claude Code のプロンプトにドラッグ&ドロップ／貼り付けした画像を、モデルに渡る前に縮小する mod です（試作）。

> **状態**: macOS では、1枚ずつのドラッグ&ドロップで縮小の動作を確かめました。Linux は、使うコマンド（ImageMagick 6・`base64`・`mktemp`・`find`）を Ubuntu 24.04 で試しただけで、Claude Code 上では未確認です。複数枚の同時添付と、クリップボードからの貼り付けも未確認です。

## 動き

1. 送信時に添付画像を取り出し、ユーザー専用の一時フォルダに保存する（送信ごとに `mktemp -d` で作る `$TMPDIR/claude-imgdec.XXXXXX/`）
2. ImageMagick があれば、周囲の単色の余白を切り落とす（文字の大きさは変わらない。面積が 85% 以下になるときだけ採用）
3. それでも長辺が 1024px を超えていれば縮小する
4. 小さくできた画像はプロンプトから外し、代わりに「このパスを Read して」という指示をモデルに渡す
5. 会話に結果を1行残す（`imgdec: 2000×1333 → 1024×682 (resize, ~3,456 → 925 tokens)`。モデルには送られない）

保存した画像は、モデルが読み直す場合に備えて一時的に残し、1日より古いフォルダを次の実行時に消します（OS が先に消すこともあります）。

小さくならない画像（余白がなく 1024px 以下）と、途中で失敗した画像は、元の添付のまま通します。GIF は対象外です。

画像のトークン数は縦横のピクセル数で決まるので、減らすのはピクセル数だけです（圧縮率や色数は変えません）。

## 使い方

```text
/imgdec        今の状態（ON/OFF・上限・余白カットの可否）と、直近の結果を表示
/imgdec off    止める（画像はそのまま渡る。細かい文字を元の解像度で読ませたいとき）
/imgdec on     再開する（既定）
```

ON/OFF はセッションをまたいで残ります。上限（1024px）と余白カットの有無は、今は `imgdec/hooks/register.ts` の `DEFAULTS` で変えます。

## 必要なもの

- Claude Code（mods が使える版）
- macOS か Linux（Windows は対象外）
- ImageMagick（`brew install imagemagick` / `apt install imagemagick`。7 の `magick` と 6 の `convert` のどちらでも可）
  - macOS では無くても動きます（標準の `sips` で縮小だけ行い、余白の切り落としはしません）
  - Linux では必須です（無ければ何もせず、画像をそのまま通します）

## 導入

```bash
claude plugin marketplace add nakamura-shuta/claude-mod-imgdec
claude plugin install imgdec@claude-mod-imgdec
```

private リポジトリなので、読める権限と github.com の git 認証が必要です。

## 分かっている課題

- 添付の順番と、保存される画像ブロックの順番が同じという前提で書いている（ずれると別の画像を外す）
