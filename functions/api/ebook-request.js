/**
 * Cloudflare Pages Function — POST /api/ebook-request  (v2, Phase 1A)
 *
 * Reçoit { name, email, lang, consent_marketing, source_article, source_url }
 * depuis le formulaire d'article.
 *
 * Pipeline :
 *   1. Validation des entrées
 *   2. Hash IP + User-Agent (preuve de consentement LCAP)
 *   3. INSERT dans Supabase (table public.vw_marketing_leads)
 *   4. Envoi du courriel J+0 via Resend (livraison du PDF)
 *   5. UPDATE Supabase avec funnel_email_1_sent_at
 *   6. Retour 200 au client
 *
 * Variables d'environnement requises (Cloudflare Pages → Settings → Environment variables):
 *   - RESEND_API_KEY                (secret) — clé API Resend
 *   - SUPABASE_URL                  (texte)  — ex. https://abc.supabase.co
 *   - SUPABASE_SERVICE_ROLE_KEY     (secret) — service_role key (PAS l'anon key)
 *   - IP_HASH_SECRET                (secret) — sel pour SHA-256 IP (généré avec openssl rand -hex 32)
 *   - SITE_URL                      (texte)  — ex. https://vectorplanning.ai
 *
 * Optionnel :
 *   - EBOOK_FROM       — défaut: "Vector <support@mail.vectorplanning.ai>"
 *   - EBOOK_REPLY_TO   — défaut: "support@vectorplanning.ai"
 */

const DEFAULT_FROM = 'Vector <support@mail.vectorplanning.ai>';
const DEFAULT_REPLY_TO = 'support@vectorplanning.ai';

const EBOOK_URL_FR = 'https://vectorplanning.ai/ebooks/vector-anti-surprise-fr.pdf';
const EBOOK_URL_EN = 'https://vectorplanning.ai/ebooks/vector-anti-surprise-en.pdf';


export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // ── 1. Validation des entrées ─────────────────────────────────
        let data;
        try {
            data = await request.json();
        } catch {
            return jsonError('Invalid JSON payload', 400);
        }

        const name = typeof data.name === 'string' ? data.name.trim() : '';
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        const lang = data.lang === 'en' ? 'en' : 'fr';
        const consentMarketing = data.consent_marketing === true;
        const sourceArticle = typeof data.source_article === 'string'
            ? data.source_article.trim().slice(0, 200)
            : null;
        const sourceUrl = typeof data.source_url === 'string'
            ? data.source_url.trim().slice(0, 500)
            : null;

        if (!name || name.length > 80) return jsonError('Invalid name', 400);
        if (!email || email.length > 180 || !isValidEmail(email)) return jsonError('Invalid email', 400);

        // ── 2. Vérification de la configuration ───────────────────────
        const requiredEnv = ['RESEND_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'IP_HASH_SECRET'];
        for (const k of requiredEnv) {
            if (!env[k]) {
                console.error(`Missing env var: ${k}`);
                return jsonError('Server configuration error', 500);
            }
        }

        // ── 3. Hash IP et User-Agent (preuve de consentement LCAP) ────
        const ip = request.headers.get('CF-Connecting-IP')
                || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
                || '';
        const userAgent = request.headers.get('User-Agent') || '';

        const ipHash = ip ? await saltedSha256(ip, env.IP_HASH_SECRET) : null;
        const uaHash = userAgent ? await saltedSha256(userAgent, env.IP_HASH_SECRET) : null;

        // ── 4. INSERT dans Supabase ──────────────────────────────────
        const supabaseHeaders = {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        };

        const insertPayload = {
            name: name,
            email: email,
            lang: lang,
            source_form: 'ebook_anti_surprise',
            source_article: sourceArticle,
            source_url: sourceUrl,
            consent_marketing: consentMarketing,
            consent_ip_hash: ipHash,
            consent_user_agent_hash: uaHash
            // id, unsubscribe_token, consent_timestamp, status, created_at, updated_at
            // → tous remplis par les defaults Postgres
        };

        const insertRes = await fetch(
            `${env.SUPABASE_URL}/rest/v1/vw_marketing_leads`,
            {
                method: 'POST',
                headers: supabaseHeaders,
                body: JSON.stringify(insertPayload)
            }
        );

        if (!insertRes.ok) {
            const errBody = await insertRes.text().catch(() => '');
            console.error('Supabase insert error:', insertRes.status, errBody);
            // On continue quand même : la livraison du PDF prime sur le tracking
            // (mais on ne pourra pas générer le lien d'unsubscribe correct)
            // → décision : si Supabase tombe, on REFUSE pour ne pas envoyer un
            //   courriel sans pouvoir gérer le désabonnement.
            return jsonError('Database error', 502);
        }

        const insertedRows = await insertRes.json();
        const lead = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;
        if (!lead?.id || !lead?.unsubscribe_token) {
            console.error('Supabase insert returned unexpected shape:', insertedRows);
            return jsonError('Database error', 502);
        }

        // ── 5. Envoi du courriel J+0 via Resend ──────────────────────
        const safeName = escapeHtml(name);
        const isEn = lang === 'en';
        const ebookUrl = isEn ? EBOOK_URL_EN : EBOOK_URL_FR;
        const siteUrl = env.SITE_URL || 'https://vectorplanning.ai';
        const unsubUrl = `${siteUrl}/api/unsubscribe?token=${lead.unsubscribe_token}&lang=${lang}`;

        const subject = isEn
            ? 'Your free guide: The anti-surprise system'
            : 'Ton guide gratuit : Le système anti-surprise';

        const html = isEn
            ? buildEmailEN(safeName, ebookUrl, unsubUrl, consentMarketing)
            : buildEmailFR(safeName, ebookUrl, unsubUrl, consentMarketing);
        const text = isEn
            ? buildTextEN(name, ebookUrl, unsubUrl, consentMarketing)
            : buildTextFR(name, ebookUrl, unsubUrl, consentMarketing);

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
                    // En-tête RFC 8058 pour le désabonnement en un clic (Gmail/Yahoo l'exigent)
                    'List-Unsubscribe': `<${unsubUrl}>`,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
                }
            })
        });

        if (!resendRes.ok) {
            const errBody = await resendRes.text().catch(() => '');
            console.error('Resend error:', resendRes.status, errBody);
            // Le lead est en base mais le courriel n'a pas été envoyé.
            // On laisse le lead en place : l'usager peut re-soumettre, ou on
            // peut le retrouver et lui réenvoyer manuellement.
            return jsonError('Email delivery failed', 502);
        }

        // ── 6. Marquer le courriel J+0 comme envoyé ──────────────────
        // Non-bloquant : si ça échoue, on ne refuse pas la requête car le
        // courriel est déjà parti. Au pire, le workflow n8n verra plus tard
        // que funnel_email_1_sent_at est NULL et ne fera rien (cohérent).
        const nowIso = new Date().toISOString();
        fetch(
            `${env.SUPABASE_URL}/rest/v1/vw_marketing_leads?id=eq.${lead.id}`,
            {
                method: 'PATCH',
                headers: supabaseHeaders,
                body: JSON.stringify({
                    funnel_email_1_sent_at: nowIso,
                    last_email_sent_at: nowIso,
                    last_email_kind: 'ebook_delivery'
                })
            }
        ).catch(err => console.error('Supabase post-send update failed:', err));

        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        console.error('Unexpected error in ebook-request:', err);
        return jsonError('Internal error', 500);
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

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

/**
 * SHA-256 salé. Le sel est composé du secret + date du jour (UTC YYYY-MM-DD).
 * Tronqué à 48 caractères hex (~192 bits) — suffisant pour preuve de
 * consentement LCAP, économe en stockage.
 */
async function saltedSha256(input, secret) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const data = new TextEncoder().encode(`${input}|${secret}|${today}`);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 48);
}


// ──────────────────────────────────────────────────────────────────────────
// Templates email — FR
// ──────────────────────────────────────────────────────────────────────────

function buildEmailFR(name, url, unsubUrl, consentMarketing) {
    const closingNote = consentMarketing
        ? `<p style="margin:0;font-size:12px;color:#6b7290;line-height:1.5;">Tu reçois ce courriel parce que tu as téléchargé un guide sur vectorplanning.ai. Tu as aussi accepté de recevoir nos conseils de planification par courriel (max 1 par semaine). <a href="${unsubUrl}" style="color:#6b7290;">Se désinscrire en un clic</a>.</p>`
        : `<p style="margin:0;font-size:12px;color:#6b7290;line-height:1.5;">Tu reçois ce courriel parce que tu as téléchargé un guide sur vectorplanning.ai. Nous t'enverrons au maximum trois courriels de suivi liés à ce guide sur les 14 prochains jours. <a href="${unsubUrl}" style="color:#6b7290;">Se désinscrire en un clic</a>.</p>`;

    return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ton guide Vector</title></head>
<body style="margin:0;padding:0;background:#f5f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f4ef;padding:2.5rem 1rem;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="580" style="max-width:580px;background:#ffffff;border-radius:12px;padding:2.5rem 2rem;color:#1a1f2e;line-height:1.65;font-size:16px;">
        <tr><td>
          <p style="margin:0 0 1.2rem;">Salut ${name},</p>
          <p style="margin:0 0 1.2rem;">Voici le guide que tu as demandé : <strong>Le système anti-surprise — 5 étapes pour solopreneurs qui jonglent plusieurs projets</strong>.</p>
          <p style="margin:2rem 0;text-align:center;">
            <a href="${url}" style="display:inline-block;background:#10131A;color:#8BFF3C;padding:1rem 2rem;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Télécharger le guide (PDF)</a>
          </p>
          <p style="margin:0 0 1.2rem;">Lis-le cette semaine — il est conçu pour être appliqué, pas étudié. Garde un crayon proche, il y a trois petits exercices au fil de la lecture.</p>
          <p style="margin:0 0 1.2rem;">Si tu as une question ou un commentaire après l'avoir lu, réponds simplement à ce courriel. Je le lis.</p>
          <p style="margin:0 0 0.3rem;">Bonne lecture,</p>
          <p style="margin:0;"><strong>Chantal</strong> · Vector</p>
          <hr style="margin:2.5rem 0 1.5rem;border:none;border-top:1px solid #e5e7eb;">
          ${closingNote}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildTextFR(name, url, unsubUrl, consentMarketing) {
    const note = consentMarketing
        ? `Tu reçois ce courriel parce que tu as téléchargé un guide sur vectorplanning.ai. Tu as aussi accepté de recevoir nos conseils de planification par courriel (max 1 par semaine).\n\nSe désinscrire : ${unsubUrl}`
        : `Tu reçois ce courriel parce que tu as téléchargé un guide sur vectorplanning.ai. Nous t'enverrons au maximum trois courriels de suivi liés à ce guide sur les 14 prochains jours.\n\nSe désinscrire : ${unsubUrl}`;

    return `Salut ${name},

Voici le guide que tu as demandé : Le système anti-surprise — 5 étapes pour solopreneurs qui jonglent plusieurs projets.

Télécharger le guide (PDF) : ${url}

Lis-le cette semaine — il est conçu pour être appliqué, pas étudié. Garde un crayon proche, il y a trois petits exercices au fil de la lecture.

Si tu as une question ou un commentaire après l'avoir lu, réponds simplement à ce courriel. Je le lis.

Bonne lecture,
Chantal · Vector

---
${note}`;
}


// ──────────────────────────────────────────────────────────────────────────
// Templates email — EN
// ──────────────────────────────────────────────────────────────────────────

function buildEmailEN(name, url, unsubUrl, consentMarketing) {
    const closingNote = consentMarketing
        ? `<p style="margin:0;font-size:12px;color:#6b7290;line-height:1.5;">You're receiving this email because you downloaded a guide on vectorplanning.ai. You also opted in to receive our planning tips (max 1 per week). <a href="${unsubUrl}" style="color:#6b7290;">Unsubscribe in one click</a>.</p>`
        : `<p style="margin:0;font-size:12px;color:#6b7290;line-height:1.5;">You're receiving this email because you downloaded a guide on vectorplanning.ai. We'll send you at most three follow-up emails related to this guide over the next 14 days. <a href="${unsubUrl}" style="color:#6b7290;">Unsubscribe in one click</a>.</p>`;

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your Vector guide</title></head>
<body style="margin:0;padding:0;background:#f5f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f4ef;padding:2.5rem 1rem;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="580" style="max-width:580px;background:#ffffff;border-radius:12px;padding:2.5rem 2rem;color:#1a1f2e;line-height:1.65;font-size:16px;">
        <tr><td>
          <p style="margin:0 0 1.2rem;">Hi ${name},</p>
          <p style="margin:0 0 1.2rem;">Here's the guide you requested: <strong>The anti-surprise system — 5 steps for solopreneurs juggling multiple projects</strong>.</p>
          <p style="margin:2rem 0;text-align:center;">
            <a href="${url}" style="display:inline-block;background:#10131A;color:#8BFF3C;padding:1rem 2rem;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Download the guide (PDF)</a>
          </p>
          <p style="margin:0 0 1.2rem;">Read it this week — it's built to be applied, not studied. Keep a pen nearby; there are three small exercises along the way.</p>
          <p style="margin:0 0 1.2rem;">If you have any question or comment after reading it, just reply to this email. I read every one.</p>
          <p style="margin:0 0 0.3rem;">Happy reading,</p>
          <p style="margin:0;"><strong>Chantal</strong> · Vector</p>
          <hr style="margin:2.5rem 0 1.5rem;border:none;border-top:1px solid #e5e7eb;">
          ${closingNote}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildTextEN(name, url, unsubUrl, consentMarketing) {
    const note = consentMarketing
        ? `You're receiving this email because you downloaded a guide on vectorplanning.ai. You also opted in to receive our planning tips (max 1 per week).\n\nUnsubscribe: ${unsubUrl}`
        : `You're receiving this email because you downloaded a guide on vectorplanning.ai. We'll send you at most three follow-up emails related to this guide over the next 14 days.\n\nUnsubscribe: ${unsubUrl}`;

    return `Hi ${name},

Here's the guide you requested: The anti-surprise system — 5 steps for solopreneurs juggling multiple projects.

Download the guide (PDF): ${url}

Read it this week — it's built to be applied, not studied. Keep a pen nearby; there are three small exercises along the way.

If you have any question or comment after reading it, just reply to this email. I read every one.

Happy reading,
Chantal · Vector

---
${note}`;
}
