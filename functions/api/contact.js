/**
 * 磯部医院 - お問い合わせフォーム受信用 Cloudflare Pages Function
 * ------------------------------------------------------------
 * このファイルの場所: /functions/api/contact.js
 * → サイトの /api/contact エンドポイントとして自動的に有効になります
 * → 公開URL: https://isobe-clini.pages.dev/
 *
 * 必要な設定（Cloudflareダッシュボードで行う）:
 * 1. Brevo（brevo.com）でアカウント作成し、APIキーを取得
 *    → SMTP & API → API Keys で「v3 API key」を発行
 *    → Senders, domains & dedicated IPs → Senders で clinic.isobe@gmail.com を追加・認証
 *    ※ 独自ドメインを取得・認証した場合は、下記 "sender" を認証済みドメインに変更してください
 * 2. Cloudflare Turnstile（Cloudflareダッシュボード → Turnstile）でサイトを追加
 *    → ドメインに isobe-clini.pages.dev を登録し、サイトキーとシークレットキーを取得
 *    → 取得したサイトキーを index.html の data-sitekey に設定
 *      （現在は動作確認用のCloudflare公式テストキー "1x00000000000000000000AA" が
 *      設定されています。常に成功扱いになりスパム対策として機能しないため、
 *      公開前に必ず本番用のサイトキーに差し替えてください）
 * 3. Pages プロジェクト → Settings → Environment variables
 *    → 変数名 "BREVO_API_KEY" を Secret として追加（値はBrevoのAPIキー）
 *    → 変数名 "TURNSTILE_SECRET_KEY" を Secret として追加（値はTurnstileのシークレットキー）
 *
 * 【再試行について】
 * Brevo側が一時的に不調な場合に備え、最大3回まで自動的に再試行します
 * （即時 → 失敗なら2秒後 → 失敗なら4秒後）。Cloudflare Pages Functionsの
 * 実行時間制限（30秒）内に収まる、シンプルな範囲での再試行です。
 * より長時間・複数ステップにわたる再試行が必要な場合は、別途Cloudflare
 * Workflows（専用Workerが必要）の導入をご検討ください。
 */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function verifyTurnstile(context, token) {
  if (!token) return false;

  const formData = new FormData();
  formData.append('secret', context.env.TURNSTILE_SECRET_KEY);
  formData.append('response', token);
  const ip = context.request.headers.get('CF-Connecting-IP');
  if (ip) formData.append('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });
    const outcome = await res.json();
    return outcome.success === true;
  } catch (err) {
    console.error('Turnstile verification failed:', err.message || String(err));
    return false;
  }
}

async function sendViaBrevo(context, { name, phone, email, message }) {
  return fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': context.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      // sender は Brevo の「送信者」で認証済みのアドレスである必要があります
      // 独自ドメイン取得・認証後は、例: { name: '磯部医院ウェブサイト', email: 'website@isobe-clinic.jp' } に変更してください
      sender: { name: '磯部医院ウェブサイト', email: 'clinic.isobe@gmail.com' },
      to: [{ email: 'clinic.isobe@gmail.com', name: '磯部医院' }],
      replyTo: email ? { email, name } : undefined,
      subject: `【ウェブサイト】新しいお問い合わせ - ${name}様`,
      textContent:
        `お名前: ${name}
` +
        `電話番号: ${phone || '未入力'}
` +
        `メールアドレス: ${email || '未入力'}

` +
        `お問い合わせ内容:
${message}`,
    }),
  });
}

export async function onRequestPost(context) {
  try {
    const data = await context.request.json();

    // ===== 簡易バリデーション（サーバー側でも必ず確認する） =====
    const name = (data.name || '').toString().trim();
    const phone = (data.phone || '').toString().trim();
    const email = (data.email || '').toString().trim();
    const message = (data.message || '').toString().trim();
    const turnstileToken = (data.turnstileToken || '').toString().trim();

    if (!name || !message) {
      return new Response(JSON.stringify({ result: 'error', message: '必須項目が不足しています' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!phone && !email) {
      return new Response(JSON.stringify({ result: 'error', message: '電話番号かメールアドレスのいずれかが必要です' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== Turnstileでスパム・ボット送信を検証 =====
    const turnstileOk = await verifyTurnstile(context, turnstileToken);
    if (!turnstileOk) {
      return new Response(JSON.stringify({ result: 'error', message: '認証に失敗しました。もう一度お試しください。' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== Brevo経由でメール送信（自動再試行つき） =====
    const delaysMs = [0, 2000, 4000]; // 即時 → 2秒後 → 4秒後（合計最大3回試行）
    let lastErrorText = '';

    for (let attempt = 0; attempt < delaysMs.length; attempt++) {
      if (delaysMs[attempt] > 0) await sleep(delaysMs[attempt]);

      try {
        const brevoRes = await sendViaBrevo(context, { name, phone, email, message });

        if (brevoRes.ok) {
          return new Response(JSON.stringify({ result: 'success' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        lastErrorText = await brevoRes.text();
        console.error(`Brevo API error (attempt ${attempt + 1}/${delaysMs.length}):`, lastErrorText);

      } catch (fetchErr) {
        lastErrorText = fetchErr.message || String(fetchErr);
        console.error(`Brevo fetch failed (attempt ${attempt + 1}/${delaysMs.length}):`, lastErrorText);
      }
    }

    // 全ての再試行が失敗した場合
    return new Response(JSON.stringify({ result: 'error', message: 'メール送信に失敗しました（再試行後も失敗）' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Contact function error:', err);
    return new Response(JSON.stringify({ result: 'error', message: 'サーバーエラーが発生しました' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
