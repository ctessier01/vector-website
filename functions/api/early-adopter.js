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
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        const lang = data.lang === 'en' ? 'en' : 'fr';
        const domain = typeof data.domain === 'string' ? data.domain.trim().slice(0, 120) : null;
        const stress = typeof data.stress === 'string' ? data.stress.trim().slice(0, 500) : null;
        const sourceUrl = typeof data.source_url === 'string' ? data.source_url.trim().slice(0, 500) : null;
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
            email: email,
            lang: lang,
            domain: domain,
            stress: stress,
            source_url: sourceUrl,
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
        if (env.RESEND_API_KEY) {
            emailPromise = sendConfirmationEmail({ env, lang, name, email, unsubUrl, leadId: lead.id, supabaseHeaders });
        } else {
            console.warn('RESEND_API_KEY absent : confirmation early adopter non envoyée.');
        }

        context.waitUntil(Promise.allSettled([eventPromise, emailPromise]));

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

function buildEmailFR(name, unsubUrl) {
    return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Tu es sur la liste — Vector</title></head>
<body style="margin:0;padding:0;background:#f5f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f4ef;padding:2.5rem 1rem;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="580" style="max-width:580px;background:#ffffff;border-radius:12px;padding:2.5rem 2rem;color:#1a1f2e;line-height:1.65;font-size:16px;">
        <tr><td>
          <p style="margin:0 0 1.2rem;">Salut ${name},</p>
          <p style="margin:0 0 1.2rem;">C'est noté : tu es sur la liste des early adopters de Vector. Merci de ton intérêt — ça compte beaucoup à ce stade-ci.</p>
          <p style="margin:0 0 1.2rem;">Je t'écrirai dès que la bêta sera prête à t'accueillir, avec ton accès et les détails. Les 25 premiers testeurs reçoivent 3 mois Pro gratuits + accès prioritaire au plan Fondateur.</p>
          <p style="margin:0 0 1.2rem;">D'ici là, si tu as une question, réponds simplement à ce courriel. Je le lis.</p>
          <p style="margin:0 0 0.3rem;">À très bientôt,</p>
          <p style="margin:0;"><strong>Chantal</strong> · Vector</p>
          <hr style="margin:2.5rem 0 1.5rem;border:none;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;color:#6b7290;line-height:1.5;">Tu reçois ce courriel parce que tu t'es inscrit·e à la liste d'attente sur vectorplanning.ai. <a href="${unsubUrl}" style="color:#6b7290;">Se retirer de la liste en un clic</a>.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildTextFR(name, unsubUrl) {
    return `Salut ${name},

C'est noté : tu es sur la liste des early adopters de Vector. Merci de ton intérêt — ça compte beaucoup à ce stade-ci.

Je t'écrirai dès que la bêta sera prête à t'accueillir, avec ton accès et les détails. Les 25 premiers testeurs reçoivent 3 mois Pro gratuits + accès prioritaire au plan Fondateur.

D'ici là, si tu as une question, réponds simplement à ce courriel. Je le lis.

À très bientôt,
Chantal · Vector

---
Tu reçois ce courriel parce que tu t'es inscrit·e à la liste d'attente sur vectorplanning.ai.
Se retirer de la liste : ${unsubUrl}`;
}

function buildEmailEN(name, unsubUrl) {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>You're on the list — Vector</title></head>
<body style="margin:0;padding:0;background:#f5f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f4ef;padding:2.5rem 1rem;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="580" style="max-width:580px;background:#ffffff;border-radius:12px;padding:2.5rem 2rem;color:#1a1f2e;line-height:1.65;font-size:16px;">
        <tr><td>
          <p style="margin:0 0 1.2rem;">Hi ${name},</p>
          <p style="margin:0 0 1.2rem;">You're on the list — you're now an early adopter of Vector. Thanks for your interest; it means a lot at this stage.</p>
          <p style="margin:0 0 1.2rem;">I'll write as soon as the beta is ready for you, with your access and the details. The first 25 testers get 3 months of Pro free + priority access to the Founder plan.</p>
          <p style="margin:0 0 1.2rem;">In the meantime, if you have a question, just reply to this email. I read every one.</p>
          <p style="margin:0 0 0.3rem;">Talk soon,</p>
          <p style="margin:0;"><strong>Chantal</strong> · Vector</p>
          <hr style="margin:2.5rem 0 1.5rem;border:none;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;color:#6b7290;line-height:1.5;">You're receiving this email because you joined the waitlist on vectorplanning.ai. <a href="${unsubUrl}" style="color:#6b7290;">Remove yourself from the list in one click</a>.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildTextEN(name, unsubUrl) {
    return `Hi ${name},

You're on the list — you're now an early adopter of Vector. Thanks for your interest; it means a lot at this stage.

I'll write as soon as the beta is ready for you, with your access and the details. The first 25 testers get 3 months of Pro free + priority access to the Founder plan.

In the meantime, if you have a question, just reply to this email. I read every one.

Talk soon,
Chantal · Vector

---
You're receiving this email because you joined the waitlist on vectorplanning.ai.
Remove yourself from the list: ${unsubUrl}`;
}
