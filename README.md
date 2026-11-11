# imgdec

Claude Code のプロンプトにドラッグ&ドロップ／貼り付けした画像を、モデルに渡る前に縮小する mod です（試作）。

> **状態**: 1枚ずつのドラッグ&ドロップでは縮小の動作を確かめました。余白の切り落とし（0.2.0）は実際の添付では未確認です。複数枚の同時添付と、クリップボードからの貼り付けは未確認です。

## 動き

1. 送信時に添付画像を取り出し、`/tmp/claude-imgdec/` に保存する
2. ImageMagick（`magick`）があれば、周囲の単色の余白を切り落とす（文字の大きさは変わらない。面積が 85% 以下になるときだけ採用）
3. それでも長辺が 1024px を超えていれば、`sips -Z 1024` で縮小する
4. 小さくできた画像はプロンプトから外し、代わりに「このパスを Read して」という指示をモデルに渡す
5. 会話に前後のピクセル数を1行残す（`imgdec: 2000×1333 → 1024×682`。モデルには送られない）

小さくならない画像（余白がなく 1024px 以下）と、途中で失敗した画像は、元の添付のまま通します。GIF は対象外です。上限は `imgdec/hooks/register.ts` 冒頭の `MAX_EDGE` で変えます。

画像のトークン数は縦横のピクセル数で決まるので、減らすのはピクセル数だけです（圧縮率や色数は変えません）。

## 必要なもの

- Claude Code（mods が使える版）
- macOS（`sips` と `base64 -D` を使います）
- ImageMagick（任意。`brew install imagemagick`）。あれば余白を切り落とします。無ければ縮小だけ行います

## 導入

```bash
claude plugin marketplace add nakamura-shuta/claude-mod-imgdec
claude plugin install imgdec@claude-mod-imgdec
```

private リポジトリなので、読める権限と github.com の git 認証が必要です。

## 分かっている課題

- 添付の順番と、保存される画像ブロックの順番が同じという前提で書いている（ずれると別の画像を外す）
- `/tmp/claude-imgdec/` の一時ファイルは自動では消えない
