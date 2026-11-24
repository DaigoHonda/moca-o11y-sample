import * as Sentry from 'https://esm.sh/@sentry/browser@11.17.0';

const sdkStatusEl = document.getElementById('sdk-status');
const statusEl = document.getElementById('status');
const traceInfoEl = document.getElementById('trace-info');

const emailInput = document.getElementById('email');
const memoInput = document.getElementById('memo');

const btnBuy = document.getElementById('btn-buy');
const btnSlow = document.getElementById('btn-slow');
const btnHandled = document.getElementById('btn-handled');
const btnUnhandled = document.getElementById('btn-unhandled');
const btnRejection = document.getElementById('btn-rejection');

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function redactEmails(text) {
  return typeof text === 'string' ? text.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]') : text;
}

function setStatus(message, tone = 'neutral') {
  statusEl.textContent = message;
  statusEl.className = tone === 'neutral' ? 'panel' : `panel ${tone}`;
}

function setTraceInfo(traceId, detail = '') {
  if (!traceId) {
    traceInfoEl.textContent = 'trace_id なし';
    return;
  }
  traceInfoEl.textContent = detail ? `${traceId}（${detail}）` : traceId;
}

async function initSentry() {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`config.json の取得に失敗しました (${res.status})`);
    }
    const config = await res.json();

    if (!config.dsn) {
      sdkStatusEl.textContent =
        'Sentry 未設定（.env に SENTRY_DSN を設定すると Sentry へ送信されます。ローカル API 検証はそのまま実行できます）';
      return;
    }

    Sentry.init({
      // 送信先プロジェクトを識別する公開キー（ブラウザ用なので公開前提だが、.env 経由で差し替えやすくしている）
      dsn: config.dsn,
      // 本番・検証・開発など、どの環境のデータかを Sentry 上で切り分けるために設定
      environment: config.environment || 'development',
      // ソースマップのひも付けや「どのリリースで発生したエラーか」を追跡するため、アップロード時と揃える
      release: config.release || 'moca-web@1.0.0',
      // 学習用サンプルのため全リクエストのトレースを100%取得する（本番トラフィックでは 0.05〜0.2 等へ下げる）
      tracesSampleRate: 1.0,
      // 同一オリジン（/api/...）や localhost への fetch に sentry-trace / baggage ヘッダを自動付与し、
      // ブラウザとサーバーのトレースをつなぐ（サードパーティへのヘッダ漏洩を防ぐため対象を明示）
      tracePropagationTargets: ['localhost', /^\//],
      // 通常セッションのリプレイは10%に抑えて課金・データ量を節約しつつ、挙動は確認できるようにする
      replaysSessionSampleRate: 0.1,
      // エラーが起きたセッションだけは確実に原因を映像で追いたいため 100% 記録する
      replaysOnErrorSampleRate: 1.0,
      integrations: [
        // ページ遷移や fetch のスパンを自動計測して分散トレーシングを有効にする
        Sentry.browserTracingIntegration(),
        // 画面操作の録画を有効化。プライバシー保護のため初期状態で全テキストをマスクしメディアも遮断する
        Sentry.replayIntegration({
          maskAllText: true,
          blockAllMedia: true,
        }),
      ],
      // 送信直前にイベントを検査・加工し、うっかりエラーメッセージに混入したメールアドレスをマスクする
      beforeSend(event) {
        if (event.message) {
          event.message = redactEmails(event.message);
        }
        if (Array.isArray(event.exception?.values)) {
          for (const ex of event.exception.values) {
            if (ex.value) {
              ex.value = redactEmails(ex.value);
            }
          }
        }
        if (Array.isArray(event.breadcrumbs)) {
          for (const crumb of event.breadcrumbs) {
            if (crumb.message) {
              crumb.message = redactEmails(crumb.message);
            }
          }
        }
        return event;
      },
    });

    sdkStatusEl.textContent = `Sentry 有効（environment: ${config.environment}, release: ${config.release}）`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sdkStatusEl.textContent = `設定の読み込みに失敗しました: ${message}`;
  }
}

/**
 * 決済失敗を名前付き関数で切り出すことで、Sentry のスタックトレース上に
 * executeCheckout -> handleCheckoutFailure の呼び出し経路が分かりやすく残る。
 */
function handleCheckoutFailure(err) {
  Sentry.captureException(err, {
    tags: {
      step: 'checkout',
      handled: 'true',
    },
  });
}

async function executeCheckout({ slow = false, fail = false } = {}) {
  const buttons = [btnBuy, btnSlow, btnHandled];
  for (const btn of buttons) {
    btn.disabled = true;
  }

  setStatus(slow ? '遅い API (/api/orders) で決済処理中...' : '注文 API (/api/orders) へ送信中...');

  try {
    await Sentry.startSpan(
      {
        name: 'moca.checkout',
        op: 'ui.action.click',
        attributes: {
          'moca.slow': slow,
          'moca.fail': fail,
        },
      },
      async () => {
        const startedAt = performance.now();
        let outcome = 'error';

        try {
          const payload = {
            orderId: `ord_${Date.now()}`,
            items: slow ? ['ethiopia-moca-200g', 'slow'] : ['ethiopia-moca-200g'],
            cardToken: fail ? 'tok_fail' : 'tok_ok',
            email: emailInput.value,
            memo: memoInput.value,
          };

          const res = await fetch('/api/orders', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });

          const data = await res.json();

          if (!res.ok) {
            outcome = 'declined';
            const err = new Error(`決済エラー (${res.status}): ${data.error ?? 'unknown_error'}`);
            if (fail) {
              handleCheckoutFailure(err);
            }
            setStatus(`注文失敗 (${res.status}): ${data.error ?? 'unknown_error'}`, 'error');
            setTraceInfo(data.traceId, `HTTP ${res.status} / handled`);
            return;
          }

          outcome = 'success';
          setStatus(
            `注文完了: orderId=${data.orderId}${slow ? '（遅延 400ms シミュレーション）' : ''}`,
            'ok'
          );
          setTraceInfo(data.traceId, `HTTP ${res.status}`);
        } catch (err) {
          outcome = 'network_error';
          const normalized = err instanceof Error ? err : new Error(String(err));
          handleCheckoutFailure(normalized);
          setStatus(`通信エラー: ${normalized.message}`, 'error');
        } finally {
          const durationMs = Math.round(performance.now() - startedAt);
          Sentry.metrics?.count?.('moca.checkout.attempt', 1, {
            attributes: {
              outcome,
              slow: String(slow),
            },
          });
          Sentry.metrics?.distribution?.('moca.checkout.duration', durationMs, {
            unit: 'millisecond',
            attributes: {
              outcome,
            },
          });
        }
      }
    );
  } finally {
    for (const btn of buttons) {
      btn.disabled = false;
    }
  }
}

function triggerUncaughtError() {
  throw new Error('Moca uncaught error: 未処理のUI例外（onerror / unhandled 検証）');
}

function triggerUnhandledRejection() {
  Promise.reject(
    new Error('Moca unhandled rejection: 未処理のPromise拒否（unhandledrejection / unhandled 検証）')
  );
}

btnBuy.addEventListener('click', () => {
  void executeCheckout({ slow: false, fail: false });
});

btnSlow.addEventListener('click', () => {
  void executeCheckout({ slow: true, fail: false });
});

btnHandled.addEventListener('click', () => {
  void executeCheckout({ slow: false, fail: true });
});

btnUnhandled.addEventListener('click', () => {
  setStatus('未処理の例外を発生させました（DevTools Console と Sentry Issues を確認）', 'error');
  setTimeout(triggerUncaughtError, 0);
});

btnRejection.addEventListener('click', () => {
  setStatus('未処理の Promise Rejection を発生させました（DevTools Console と Sentry Issues を確認）', 'error');
  triggerUnhandledRejection();
});

void initSentry();
