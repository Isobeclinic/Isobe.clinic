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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===== メール本文（HTML）: サイトのデザイン（空色・ミント・コーラル）に合わせたテンプレート =====
// メールクライアント互換のため table レイアウト + インラインCSSのみを使用しています
function buildHtmlEmail({ name, phone, email, message }) {
  const FONT = "'Zen Maru Gothic','Hiragino Maru Gothic ProN','Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo',sans-serif";
  const INK = '#2C3A36';
  const INK_SOFT = '#5C6D67';
  const SKY_DEEP = '#4A8DB8';
  const MINT_DEEP = '#5FB9A0';
  const CORAL = '#FF9E85';

  const receivedAt = new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  });

  const safeName = escapeHtml(name);
  const safeMessage = escapeHtml(message).replace(/\r?\n/g, '<br>');

  const telDigits = phone.replace(/[^\d+]/g, '');
  const phoneHtml = phone
    ? `<a href="tel:${escapeHtml(telDigits)}" style="color:${INK};text-decoration:none;font-weight:700;">${escapeHtml(phone)}</a>`
    : `<span style="color:#9AA8A3;">未入力</span>`;
  const emailHtml = email
    ? `<a href="mailto:${escapeHtml(email)}" style="color:${SKY_DEEP};text-decoration:none;font-weight:700;">${escapeHtml(email)}</a>`
    : `<span style="color:#9AA8A3;">未入力</span>`;

  // 返信ボタン: メールがあればメール返信、なければ電話
  const cta = email
    ? { href: `mailto:${escapeHtml(email)}?subject=${encodeURIComponent('Re: お問い合わせありがとうございます（磯部医院）')}`, label: '✉ メールで返信する', bg: SKY_DEEP }
    : { href: `tel:${escapeHtml(telDigits)}`, label: '☎ 電話をかける', bg: MINT_DEEP };

  const row = (label, valueHtml) => `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #EAF1EE;font-family:${FONT};">
            <div style="font-size:12px;letter-spacing:.08em;color:${INK_SOFT};margin-bottom:4px;">${label}</div>
            <div style="font-size:16px;color:${INK};line-height:1.6;">${valueHtml}</div>
          </td>
        </tr>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>新しいお問い合わせ</title>
</head>
<body style="margin:0;padding:0;background-color:#F3F8F6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#F3F8F6;">${safeName}様よりお問い合わせが届きました</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F3F8F6;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

        <!-- ヘッダー -->
        <tr>
          <td bgcolor="#7EB8D6" style="background-color:#7EB8D6;background-image:linear-gradient(135deg,#7EB8D6 0%,#8FD4C1 100%);border-radius:24px 24px 0 0;padding:32px 36px 28px;font-family:${FONT};">
            <div style="font-size:13px;letter-spacing:.14em;color:#FFFFFF;opacity:.95;">NEW INQUIRY ／ ウェブサイトより</div>
            <div style="font-size:26px;font-weight:900;color:#FFFFFF;margin-top:8px;letter-spacing:.06em;">磯部医院</div>
            <div style="font-size:15px;color:#FFFFFF;margin-top:6px;">新しいお問い合わせが届きました</div>
          </td>
        </tr>

        <!-- 本文カード -->
        <tr>
          <td style="background-color:#FFFFFF;padding:32px 36px 8px;font-family:${FONT};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:${FONT};padding-bottom:6px;">
                  <span style="display:inline-block;background-color:#FFF1EC;color:#E5735A;font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">📩 受信 ${escapeHtml(receivedAt)}</span>
                </td>
              </tr>
              ${row('お名前', `<span style="font-size:18px;font-weight:700;">${safeName} 様</span>`)}
              ${row('電話番号', phoneHtml)}
              ${row('メールアドレス', emailHtml)}
            </table>

            <!-- お問い合わせ内容 -->
            <div style="font-family:${FONT};font-size:12px;letter-spacing:.08em;color:${INK_SOFT};margin:24px 0 8px;">お問い合わせ内容</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:#FBFBF6;border-left:4px solid ${CORAL};border-radius:12px;padding:18px 20px;font-family:${FONT};font-size:15px;line-height:1.9;color:${INK};">${safeMessage}</td>
              </tr>
            </table>

            <!-- 返信ボタン -->
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:32px auto 28px;">
              <tr>
                <td align="center" bgcolor="${cta.bg}" style="background-color:${cta.bg};border-radius:999px;">
                  <a href="${cta.href}" style="display:inline-block;padding:14px 36px;font-family:${FONT};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:999px;">${cta.label}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- フッター -->
        <tr>
          <td style="background-color:#FFFFFF;border-top:1px solid #EAF1EE;border-radius:0 0 24px 24px;padding:22px 36px 28px;font-family:${FONT};font-size:12px;line-height:1.8;color:${INK_SOFT};">
            このメールは磯部医院公式サイトのお問い合わせフォームから自動送信されました。<br>
            「返信」ボタンでお問い合わせ者へ直接返信できます。<br>
            <span style="color:#9AA8A3;">〒612-8105 京都府京都市伏見区東奉行町1 桃山グランドハイツ2階 ／ TEL 075-574-7447</span>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
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
      htmlContent: buildHtmlEmail({ name, phone, email, message }),
      // HTML非対応のメールクライアント向けのテキスト版
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
