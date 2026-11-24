# moca-o11y-sample

Zenn 本『フロントエンドの観測性 ── 実践 Observability』第12章の別枠サンプルリポジトリです。

## 1. これは何か

書籍の第12章では、仕組みを手を動かして理解するために依存ゼロの自前実装（`sendBeacon` や軽量サーバー）で架空の珈琲豆ストア **Moca** を計測しています。

本リポジトリは、その同じ Moca の購入画面を **Sentry SDK（`@sentry/browser` v11.17.0）** で組んだ検証用サンプルです。エラー監視・分散トレーシング（ブラウザ〜Node.js サーバー）・Session Replay・ソースマップ復元を、手元のブラウザと無料枠の Sentry プロジェクトで一通り試せます。

- サーバーは **Node.js 標準モジュールのみ** で動作します（`dependencies` は空、`npm install` 不要）。
- ブラウザ側もビルド不要の ESM import（`https://esm.sh/@sentry/browser@11.17.0`）でそのまま動きます。

---

## 2. Sentry アカウント作成 〜 DSN 取得の手順（2026-11 時点）

1. [sentry.io](https://sentry.io/) にアクセスし、アカウントを作成します（Developer プランの無料枠で検証できます）。
2. 初回ログイン後、または左メニュー **Projects → Create Project** から新規プロジェクトを作成します。
   - Platform で **Browser JavaScript** を選択します。
   - 任意のプロジェクト名（例: `moca-web`）を付けて作成します。
3. 作成直後のセットアップ画面、または **Settings → Projects → 対象プロジェクト → Client Keys (DSN)** を開きます。
4. **DSN**（`https://<publicKey>@<ingestHost>/<projectId>` の形式の URL）をコピーします。

> **注意:** DSN 自体はブラウザから送信するための公開前提の値ですが、リポジトリに他人のプロジェクト DSN を残さないため、このリポジトリでは `.env`（`.gitignore` 対象）で管理します。また、ソースマップアップロードに使う `SENTRY_AUTH_TOKEN` は**機密情報**なので絶対にコミットしないでください。

---

## 3. 環境変数設定と起動手順

```bash
# 1. リポジトリを取得
git clone https://github.com/DaigoHonda/moca-o11y-sample.git
cd moca-o11y-sample

# 2. .env.example をコピーして .env を作成
cp .env.example .env
```

`.env` を開き、先ほど取得した DSN を `SENTRY_DSN=` の後ろに設定します。

```env
SENTRY_DSN=https://<publicKey>@<ingestHost>/<projectId>
PORT=8787
SENTRY_ENVIRONMENT=development
SENTRY_RELEASE=moca-web@1.0.0
```

サーバーを起動します（`npm install` は不要です）。

```bash
node server.mjs
# または
npm start
```

ブラウザで `http://localhost:8787` を開きます。`Sentry SDK 状態` に `Sentry 有効` と表示されていれば準備完了です。

---

## 4. 各ボタンと Sentry 画面の対応表

画面上の 5 つのボタンを押すと、Sentry の各画面に以下のデータが送信されます（反映まで数十秒かかる場合があります）。

| ボタン / 操作 | 何が起きるか | Sentry で確認する画面と注目ポイント |
|---|---|---|
| **購入する（正常）** (`btn-buy`) | `moca.checkout` スパンの中で `POST /api/orders`（約40ms・HTTP 201）を実行 | **Explore > Traces**: ブラウザの `moca.checkout` → `http.client` と、サーバーの `POST /api/orders`（`http.server` / `payment.authorize`）が同じ `trace_id` でつながることを確認 |
| **遅いAPIで購入する（400ms）** (`btn-slow`) | `items` に `'slow'` を含めて送信し、サーバー側で 400ms 遅延を発生 | **Explore > Traces**: `payment.authorize` スパンが約 400ms に伸び、ボトルネックがサーバー側の決済認可にあることが一目で分かる |
| **決済エラー（captureException / handled）** (`btn-handled`) | HTTP 402 応答を受け取り、`handleCheckoutFailure()` から `Sentry.captureException` を送信 | **Issues**: `handled: true` タグ付きで起票され、`executeCheckout -> handleCheckoutFailure` のスタックトレースが記録される<br>**Replays**: `replaysOnErrorSampleRate: 1.0` によりエラー発生前後の画面録画が紐づく（入力欄やテキストは `maskAllText: true` でマスク済み）<br>**Explore > Traces**: 該当トレースのステータスが失敗として記録される |
| **未処理の例外（onerror / unhandled）** (`btn-unhandled`) | `setTimeout(triggerUncaughtError, 0)` で未処理の同期例外を送出 | **Issues**: `unhandled` なエラーとして自動捕捉される<br>**Replays**: エラー時のセッションリプレイが記録される |
| **Promiseの拒否（unhandledrejection / unhandled）** (`btn-rejection`) | `triggerUnhandledRejection()` で未処理の Promise Rejection を発生 | **Issues**: `unhandledrejection` として自動捕捉される<br>**Replays**: エラー時のセッションリプレイが記録される |
| **Releases / 計測メトリクス** | `release: moca-web@1.0.0` 付きでイベントを送信し、`Sentry.metrics`（対応環境）も呼び出し | **Releases**: `moca-web@1.0.0` ごとのエラー件数・影響セッションを確認 |

---

## 5. ソースマップ生成とアップロード手順

本番環境と同様に、圧縮（minify）された JS ファイルでエラーが発生したとき、`.map` ファイルを HTTP で公開せずに Sentry 上で元のソースコード位置を復元する手順です。

1. **縮小版と外部ソースマップを生成する**（`esbuild@0.25.0` を `npx` で実行）

   ```bash
   npm run build
   ```

   `dist/app.min.js` と `dist/app.min.js.map` が生成されます。

2. **動作確認（ソースマップ適用前）**

   サーバーを起動した状態で `http://localhost:8787/minified` を開きます。縮小版の `dist/app.min.js` が読み込まれますが、`server.mjs` はセキュリティ実践として `*.map` への HTTP リクエストに **404 Not Found** を返します。この状態でエラーボタン（例: `btn-handled`）を押すと、Sentry Issues 上のスタックトレースは縮小後の行・列番号のままになります。

3. **Auth Token を用意し、`sentry-cli`（v3.8.2）で注入・アップロードする**

   Sentry の **Settings → Account → API → Auth Tokens**（または Organization の Auth Tokens）から `project:releases` / `org:read` 権限を含むトークンを発行し、**シェル環境変数**で渡します（`.env` やリポジトリには書かないでください）。

   ```bash
   export SENTRY_ORG=your-org-slug
   export SENTRY_PROJECT=your-project-slug
   export SENTRY_AUTH_TOKEN=sntrys_...

   npm run sourcemaps:upload
   ```

   内部では以下の 2 コマンドが順に実行されます（参考: [Sentry CLI Source Maps 公式ドキュメント](https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/cli/)）。
   - `npx --yes @sentry/cli@3.8.2 sourcemaps inject ./dist`: JS と `.map` の双方に一意の **Debug ID** を埋め込む
   - `npx --yes @sentry/cli@3.8.2 sourcemaps upload ./dist`: Debug ID 付きのソースマップを Sentry へアップロードする

4. **復元を確認する**

   再度 `http://localhost:8787/minified` をリロードし、エラーボタンを押します。今度は Sentry Issues のスタックトレースが元の `app.js` の関数名（`executeCheckout` や `handleCheckoutFailure`）と行番号で復元されます。

---

## 6. うまくいかないときの確認ポイント

- **イベントが Sentry に届かない（Issues / Traces が空のまま）**
  - `.env` に `SENTRY_DSN` が正しく入っているか確認し、変更後は `node server.mjs` を再起動してください。画面上の `Sentry SDK 状態` が `Sentry 有効` になっているかも確認します。
  - ブラウザの **広告ブロッカーやトラッキング防止機能**（uBlock Origin、Brave Shields など）が `*.ingest.*.sentry.io` への通信をブロックしていないか確認してください。DevTools の Network タブで `envelope` リクエストが失敗（blocked）していないかを見るのが確実です。
- **ブラウザとサーバーのトレースが 1 本につながらない**
  - `app.js` の `tracePropagationTargets: ['localhost', /^\//]` が機能しているか確認してください。`127.0.0.1:8787` など `localhost` 以外のホスト名で開いて絶対 URL を呼ぶとヘッダが付与されません（本サンプルは相対パス `/api/orders` を呼ぶため `/^\//` に一致します）。
  - サーバー側の標準出力に `[server-trace] status=200 trace_id=...` が出ているか確認してください。`status=400` や `status=403` の場合は DSN や Envelope の内容を確認してください。
- **縮小版 (`/minified`) でスタックトレースが復元されない**
  - `npm run sourcemaps:upload` 実行後、**ブラウザをリロード**してからエラーを発生させていますか？ `sourcemaps inject` は `dist/app.min.js` 自体を書き換えて Debug ID を埋め込むため、注入前の古いキャッシュをブラウザが握っていると Debug ID が一致しません。
  - `app.js` の `release`（既定 `moca-web@1.0.0`）と環境変数 `SENTRY_RELEASE` にズレがないか確認してください。
- **`/dist/app.min.js.map` にアクセスすると 404 になる**
  - **これは意図された仕様です。** 本番環境でソースマップを公開すると元のコード構造やコメントが誰でも読めてしまうため、`server.mjs` は `.map` へのアクセスをすべて `404 Not Found` にしています。ソースマップは HTTP で配らず、`sentry-cli` で Sentry へ直接アップロードして利用します。
