# ローカル圧縮

画像と動画を、アップロードせずにブラウザの中だけで圧縮するWebアプリです。
圧縮前と圧縮後をスライダーで見比べながら、画質とサイズを調整できます。

**使ってみる → https://monjofight.github.io/local-compress/**

## できること

- **画像**：JPEG・WebP・PNG に書き出し。画質とサイズ（幅・高さ）を変更できます。
- **動画**：MP4（H.264 / H.265）に圧縮。「標準」「軽量」などの画質プリセットか、「25MB以下」のような目標サイズで指定できます。
- **見比べ**：圧縮前と圧縮後をスライダーで比較。拡大・移動・回転にも対応しています。動画は2つを同じフレームに合わせて再生します。

ファイルはどこにも送信されません。ページを開くときに動画処理ライブラリを CDN から読み込むだけで、圧縮はすべてお使いの端末の中で行います。

## 対応ブラウザ

最新の Chrome / Edge をおすすめします。動画の圧縮には [WebCodecs](https://developer.mozilla.org/docs/Web/API/WebCodecs_API) が必要です。画像の圧縮はほかのブラウザでも動きます。

## 仕組み

- **画像**：Web Worker 上の `OffscreenCanvas.convertToBlob()` で書き出します。
- **動画**：WebCodecs でデコード・エンコードし、MP4 の読み書きには [Mediabunny](https://mediabunny.dev) を使っています。
- **動画のプレビュー**：再生位置から4秒だけを試しに圧縮して、元の動画と同じ時刻に合わせて表示します。「動画全体を圧縮」で全体を圧縮します。

## ファイル構成

ビルドの手順はなく、HTML・CSS・JavaScript（ES Modules）をそのまま配信しています。

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面のマークアップとアイコン |
| `style.css` | スタイル（ライト／ダーク） |
| `js/main.js` | 起動、ファイルの受け付け、画面の切り替え |
| `js/compare-view.js` | 圧縮前／圧縮後の比較ビュー（拡大・移動・境目のドラッグ） |
| `js/image-editor.js` | 画像モード |
| `js/image-worker.js` | 画像の書き出し（Web Worker） |
| `js/video-editor.js` | 動画モード（プレビューと全体の圧縮） |
| `js/video-plan.js` | 解像度・フレームレート・ビットレートの決め方 |
| `js/video-player.js` | 2本の動画を同じ時刻で並べて再生するプレーヤー |
| `js/samples.js` | 「サンプルで試す」の画像・動画の生成 |
| `js/ui.js` | 共通の小さな関数 |

## ローカルで動かす

ES Modules を使っているため、`index.html` を直接開くのではなく、静的サーバー経由で開いてください。

```bash
python3 -m http.server 8000
```

その後 http://localhost:8000 を開きます。

## ライセンス

[MIT](LICENSE)。動画処理に使用している Mediabunny は MPL-2.0 です。
