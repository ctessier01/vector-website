/**
 * Cloudflare Pages Function — POST /api/early-adopter  (Bloc 1.5)
 *
 * Inscription à la LISTE D'ATTENTE early adopter (bêta). Remplace l'ancien
 * envoi Formspree. Distinct du flux ebook (vw_marketing_leads).
 *
 * Reçoit { name, email, lang, domain, stress, source_url,
 *          utm_source, utm_medium, utm_campaign, utm_term, utm_content, referer_url }
 *
 * Pipeline :
 *   1. Validation des entrées
 *   2. Hash IP + User-Agent (preuve de soumission / anti-abus — aucune IP en clair)
 *   3. INSERT dans Supabase (public.vw_early_adopter_leads)
 *   4. Log signup_early_adopter dans marketing_events (CÔTÉ SERVEUR : a le lead_id + UTM)
 *   5. Courriel de confirmation J+0 (Resend, en parallèle) + retour JSON
 *
 * Aucun document à accepter à ce stade (liste d'attente : aucun engagement
 * réciproque). La politique de confidentialité reste accessible sur le site.
 *
 * Variables d'environnement requises (déjà configurées pour ebook-request) :
 *   - RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IP_HASH_SECRET, SITE_URL
 */

const DEFAULT_FROM = 'Vector <support@mail.vectorplanning.ai>';
const DEFAULT_REPLY_TO = 'support@vectorplanning.ai';


export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // ── 1. Validation ─────────────────────────────────────────────
        let data;
        try {
            data = await request.json();
        } catch {
            return jsonError('Invalid JSON payload', 400);
        }

        const name = typeof data.name === 'string' ? data.name.trim() : '';
        const lastName = typeof data.last_name === 'string' ? data.last_name.trim().slice(0, 80) : null;
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        const lang = data.lang === 'en' ? 'en' : 'fr';
        const domain = typeof data.domain === 'string' ? data.domain.trim().slice(0, 120) : null;
        const stress = typeof data.stress === 'string' ? data.stress.trim().slice(0, 500) : null;
        const sourceUrl = typeof data.source_url === 'string' ? data.source_url.trim().slice(0, 500) : null;
        const consentMarketing = data.consent_marketing === true;
        const utm = pickUtm(data);

        if (!name || name.length > 80) return jsonError('Invalid name', 400);
        if (!email || email.length > 180 || !isValidEmail(email)) return jsonError('Invalid email', 400);

        // ── 2. Configuration ──────────────────────────────────────────
        const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'IP_HASH_SECRET'];
        for (const k of requiredEnv) {
            if (!env[k]) {
                console.error(`Missing env var: ${k}`);
                return jsonError('Server configuration error', 500);
            }
        }

        // ── 3. Hash IP / User-Agent (aucune IP en clair) ──────────────
        const ip = request.headers.get('CF-Connecting-IP')
                || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
                || '';
        const userAgent = request.headers.get('User-Agent') || '';
        const ipHash = ip ? await saltedSha256(ip, env.IP_HASH_SECRET) : null;
        const uaHash = userAgent ? await saltedSha256(userAgent, env.IP_HASH_SECRET) : null;

        const supabaseHeaders = {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        };

        // ── 4. INSERT du lead ─────────────────────────────────────────
        const insertPayload = Object.assign({
            name: name,
            last_name: lastName,
            email: email,
            lang: lang,
            domain: domain,
            stress: stress,
            source_url: sourceUrl,
            consent_marketing: consentMarketing,
            consent_ip_hash: ipHash,
            consent_user_agent_hash: uaHash
        }, utm);

        const insertRes = await fetch(
            `${env.SUPABASE_URL}/rest/v1/vw_early_adopter_leads`,
            { method: 'POST', headers: supabaseHeaders, body: JSON.stringify(insertPayload) }
        );

        if (!insertRes.ok) {
            const errBody = await insertRes.text().catch(() => '');
            console.error('Supabase insert error:', insertRes.status, errBody);
            return jsonError('Database error', 502);
        }

        const insertedRows = await insertRes.json();
        const lead = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;
        if (!lead?.id || !lead?.unsubscribe_token) {
            console.error('Supabase insert returned unexpected shape:', insertedRows);
            return jsonError('Database error', 502);
        }

        // ── 5. Event de conversion (server-side : a le lead_id + UTM) ──
        const eventPayload = Object.assign({
            event_type: 'signup_early_adopter',
            lead_id: lead.id,
            lead_kind: 'early_adopter',
            page_slug: 'home',
            metadata: { source: 'early_access_form' }
        }, utm);

        const eventPromise = fetch(`${env.SUPABASE_URL}/rest/v1/marketing_events`, {
            method: 'POST',
            headers: Object.assign({}, supabaseHeaders, { 'Prefer': 'return=minimal' }),
            body: JSON.stringify(eventPayload)
        }).catch(err => console.error('marketing_events insert failed (non-blocking):', err));

        // ── 6. Courriel de confirmation J+0 (Resend) ──────────────────
        const siteUrl = env.SITE_URL || 'https://vectorplanning.ai';
        const unsubUrl = `${siteUrl}/api/unsubscribe?token=${lead.unsubscribe_token}&lang=${lang}`;

        let emailPromise = Promise.resolve();
        let notifyPromise = Promise.resolve();
        if (env.RESEND_API_KEY) {
            emailPromise = sendConfirmationEmail({ env, lang, name, email, unsubUrl, leadId: lead.id, supabaseHeaders });
            notifyPromise = sendOwnerNotification({ env, name, email, lang, domain, stress });
        } else {
            console.warn('RESEND_API_KEY absent : confirmation early adopter non envoyée.');
        }

        context.waitUntil(Promise.allSettled([eventPromise, emailPromise, notifyPromise]));

        // ── 7. Réponse ────────────────────────────────────────────────
        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        console.error('Unexpected error in early-adopter:', err);
        return jsonError('Internal error', 500);
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Courriel de confirmation
// ──────────────────────────────────────────────────────────────────────────

async function sendConfirmationEmail({ env, lang, name, email, unsubUrl, leadId, supabaseHeaders }) {
    const safeName = escapeHtml((name.split(/\s+/)[0]) || name);
    const isEn = lang === 'en';

    const subject = isEn ? 'You\'re on the list — Vector' : 'Tu es sur la liste — Vector';
    const html = isEn ? buildEmailEN(safeName, unsubUrl) : buildEmailFR(safeName, unsubUrl);
    const text = isEn ? buildTextEN(name, unsubUrl) : buildTextFR(name, unsubUrl);

    try {
        const resendRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: env.EBOOK_FROM || DEFAULT_FROM,
                to: [email],
                reply_to: env.EBOOK_REPLY_TO || DEFAULT_REPLY_TO,
                subject: subject,
                html: html,
                text: text,
                headers: {
                    'List-Unsubscribe': `<${unsubUrl}>`,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
                }
            })
        });

        if (!resendRes.ok) {
            const errBody = await resendRes.text().catch(() => '');
            console.error('Resend error:', resendRes.status, errBody);
            return;
        }

        const nowIso = new Date().toISOString();
        await fetch(`${env.SUPABASE_URL}/rest/v1/vw_early_adopter_leads?id=eq.${leadId}`, {
            method: 'PATCH',
            headers: supabaseHeaders,
            body: JSON.stringify({
                confirmation_email_sent_at: nowIso,
                last_email_sent_at: nowIso,
                last_email_kind: 'early_adopter_confirmation'
            })
        });
    } catch (err) {
        console.error('Confirmation email failed (non-blocking):', err);
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Notification interne — alerte le propriétaire à chaque inscription
// ──────────────────────────────────────────────────────────────────────────

async function sendOwnerNotification({ env, name, email, lang, domain, stress }) {
    const to = env.OWNER_NOTIFY_EMAIL || 'info@vectorplanning.ai';
    const rows = [
        ['Nom', name],
        ['Courriel', email],
        ['Langue', lang],
        ['Domaine', domain || '—'],
        ['Sa plus grande friction', stress || '—']
    ];
    const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const html = `<div style="font-family:${sans};font-size:15px;color:#1a1f2e;line-height:1.6;">`
        + `<h2 style="margin:0 0 14px;font-size:18px;">🎉 Nouvelle inscription bêta</h2>`
        + `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">`
        + rows.map(([k, v]) => `<tr><td style="padding:5px 16px 5px 0;color:#6b7290;vertical-align:top;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:5px 0;"><strong>${escapeHtml(String(v))}</strong></td></tr>`).join('')
        + `</table>`
        + `<p style="margin:16px 0 0;font-size:13px;color:#6b7290;">Réponds directement à ce courriel pour écrire à la personne (le « répondre à » est son adresse).</p>`
        + `</div>`;
    const text = `Nouvelle inscription bêta\n\n`
        + rows.map(([k, v]) => `${k} : ${v}`).join('\n')
        + `\n\nRéponds à ce courriel pour écrire directement à la personne.`;

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: env.EBOOK_FROM || DEFAULT_FROM,
                to: [to],
                reply_to: email,
                subject: `🎉 Nouvelle inscription bêta : ${name}`,
                html: html,
                text: text
            })
        });
        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            console.error('Owner notification error:', res.status, errBody);
        }
    } catch (err) {
        console.error('Owner notification failed (non-blocking):', err);
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function isValidEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function pickUtm(data) {
    const out = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referer_url']) {
        out[k] = typeof data[k] === 'string' && data[k].trim()
            ? data[k].trim().slice(0, k === 'referer_url' ? 500 : 200)
            : null;
    }
    return out;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

async function saltedSha256(input, secret) {
    const today = new Date().toISOString().slice(0, 10);
    const data = new TextEncoder().encode(`${input}|${secret}|${today}`);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 48);
}


// ──────────────────────────────────────────────────────────────────────────
// Templates email — FR / EN
// ──────────────────────────────────────────────────────────────────────────

// Gabarit de marque commun (en-tête sombre + wordmark Vector + pied).
// Pas de police web (Gmail les ignore) : Red Hat Display avec repli sans-serif.
function emailShell(lang, bodyHtml, footerHtml) {
    const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>Vector</title>
</head>
<body style="margin:0;padding:0;background:#F5F4EF;-webkit-text-size-adjust:100%;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F5F4EF;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(16,19,26,0.06),0 12px 32px rgba(16,19,26,0.07);">
        <tr><td style="background:#10131A;padding:24px 32px 22px;text-align:center;">
          <img src="https://vectorplanning.ai/${lang === 'en' ? 'vector-logo-email-en.png' : 'vector-logo-email.png'}" alt="${lang === 'en' ? 'Vector — AI plans. You deliver.' : "Vector — L'IA planifie. Toi tu accomplis."}" width="248" style="display:block;margin:0 auto;border:0;outline:none;width:248px;max-width:78%;height:auto;">
        </td></tr>
        <tr><td style="padding:32px;color:#1a1f2e;font-size:16px;line-height:1.65;font-family:${sans};">
${bodyHtml}
        </td></tr>
        <tr><td style="padding:0 32px 28px;font-family:${sans};">
          <div style="border-top:1px solid #ececec;padding-top:16px;font-size:12px;color:#6b7290;line-height:1.55;">${footerHtml}</div>
        </td></tr>
      </table>
      <div style="font-family:${sans};font-size:11px;color:#9aa1b3;margin-top:16px;">Vector · vectorplanning.ai</div>
    </td></tr>
  </table>
</body>
</html>`;
}

// Encadré « offre » avec barre lime à gauche.
function offerBox(html) {
    return `          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 1.3rem;"><tr>
            <td style="background:#F5F4EF;border-left:3px solid #8BFF3C;border-radius:8px;padding:14px 18px;font-size:14.5px;color:#10131A;line-height:1.55;">${html}</td>
          </tr></table>`;
}

function buildEmailFR(name, unsubUrl) {
    const body =
`          <p style="margin:0 0 1.2rem;">Bonjour ${name},</p>
          <p style="margin:0 0 1.2rem;">C'est noté : tu es sur la liste des early adopters de Vector. Merci de ton intérêt — ça compte beaucoup à ce stade-ci.</p>
          <p style="margin:0 0 1.2rem;">Je t'écrirai dès que la bêta sera prête à t'accueillir, avec ton accès et les détails.</p>
${offerBox('<strong>Les 25 premiers testeurs</strong> reçoivent <strong>3 mois du plan Accélération gratuits</strong> + un accès prioritaire au plan <strong>Délégation</strong>.')}
          <p style="margin:0 0 1.2rem;">D'ici là, si tu as une question, réponds simplement à ce courriel. Je le lis.</p>
          <p style="margin:0 0 0.3rem;">À très bientôt,</p>
          <p style="margin:0;"><strong>Chantal</strong> · Vector</p>`;
    const footer = `Tu reçois ce courriel parce que tu t'es inscrit·e à la liste d'attente sur vectorplanning.ai. <a href="${unsubUrl}" style="color:#6b7290;text-decoration:underline;">Se retirer de la liste en un clic</a>.`;
    return emailShell('fr', body, footer);
}

function buildTextFR(name, unsubUrl) {
    return `Bonjour ${name},

C'est noté : tu es sur la liste des early adopters de Vector. Merci de ton intérêt — ça compte beaucoup à ce stade-ci.

Je t'écrirai dès que la bêta sera prête à t'accueillir, avec ton accès et les détails. Les 25 premiers testeurs reçoivent 3 mois du plan Accélération gratuits + un accès prioritaire au plan Délégation.

D'ici là, si tu as une question, réponds simplement à ce courriel. Je le lis.

À très bientôt,
Chantal · Vector

---
Tu reçois ce courriel parce que tu t'es inscrit·e à la liste d'attente sur vectorplanning.ai.
Se retirer de la liste : ${unsubUrl}`;
}

function buildEmailEN(name, unsubUrl) {
    const body =
`          <p style="margin:0 0 1.2rem;">Hello ${name},</p>
          <p style="margin:0 0 1.2rem;">You're on the list — you're now an early adopter of Vector. Thanks for your interest; it means a lot at this stage.</p>
          <p style="margin:0 0 1.2rem;">I'll write as soon as the beta is ready for you, with your access and the details.</p>
${offerBox('<strong>The first 25 testers</strong> get <strong>3 months of the Acceleration plan free</strong> + priority access to the <strong>Delegation</strong> plan.')}
          <p style="margin:0 0 1.2rem;">In the meantime, if you have a question, just reply to this email. I read every one.</p>
          <p style="margin:0 0 0.3rem;">Talk soon,</p>
          <p style="margin:0;"><strong>Chantal</strong> · Vector</p>`;
    const footer = `You're receiving this email because you joined the waitlist on vectorplanning.ai. <a href="${unsubUrl}" style="color:#6b7290;text-decoration:underline;">Remove yourself from the list in one click</a>.`;
    return emailShell('en', body, footer);
}

function buildTextEN(name, unsubUrl) {
    return `Hello ${name},

You're on the list — you're now an early adopter of Vector. Thanks for your interest; it means a lot at this stage.

I'll write as soon as the beta is ready for you, with your access and the details. The first 25 testers get 3 months of the Acceleration plan free + priority access to the Delegation plan.

In the meantime, if you have a question, just reply to this email. I read every one.

Talk soon,
Chantal · Vector

---
You're receiving this email because you joined the waitlist on vectorplanning.ai.
Remove yourself from the list: ${unsubUrl}`;
}
