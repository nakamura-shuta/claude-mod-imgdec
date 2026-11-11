# image-shrink

Claude Code のプロンプトにドラッグ&ドロップ／貼り付けした画像を、モデルに渡る前に縮小する mod です（試作）。

> **状態**: `claude plugin validate` と型チェックは通っていますが、実際に画像を添付しての動作はまだ確かめていません。

## 動き

1. 送信時に添付画像を取り出し、`/tmp/claude-image-shrink/` に保存する
2. 長辺が 1024px を超える画像だけ `sips -Z 1024` で縮小する（超えない画像は添付のまま）
3. 縮小した画像はプロンプトから外し、代わりに「このパスを Read して」という指示をモデルに渡す
4. 縮小したときはトーストで知らせる

途中で失敗した画像は、元の添付のまま通します。GIF は対象外です。上限は `image-shrink/hooks/register.ts` 冒頭の `MAX_EDGE` で変えます。

## 必要なもの

- Claude Code（mods が使える版）
- macOS（`sips` と `base64 -D` を使います）

## 導入

```bash
claude plugin marketplace add nakamura-shuta/claude-mod-imgdec
claude plugin install image-shrink@claude-mod-imgdec
```

private リポジトリなので、読める権限と github.com の git 認証が必要です。

## 分かっている課題

- 添付の順番と、保存される画像ブロックの順番が同じという前提で書いている（ずれると別の画像を外す）
- 添付画像の読み出し（`$.prompt.media`）が、個人で入れた mod でも使えるかは未確認
- `/tmp/claude-image-shrink/` の一時ファイルは自動では消えない
