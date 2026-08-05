/**
 * Cloudflare Pages Function — POST /api/ebook-request  (v3, Phase 1A)
 *
 * Reçoit { name, last_name, email, lang, consent_marketing, source_form, source_article, source_url }
 * depuis un formulaire de capture d'ebook.
 *
 * Pipeline :
 *   1. Validation des entrées + résolution du lead magnet demandé
 *   2. Hash IP + User-Agent (preuve de consentement LCAP)
 *   3. INSERT dans Supabase (public.marketing_leads)
 *   4. Génération d'un token signé HMAC-SHA256 lié au lead + à la ressource
 *   5. Envoi du courriel J+0 (en parallèle) + retour JSON avec download_url
 *
 * Architecture clé :
 *   - Table LEAD_MAGNETS centralisée : pour ajouter un nouvel ebook, ajouter
 *     une entrée ici + uploader les PDF. Aucune nouvelle Function nécessaire.
 *   - Token signé HMAC : pas de stockage côté serveur, vérifiable par
 *     /api/download sans appel base de données pour la signature.
 *   - Double livraison : bouton de téléchargement immédiat (UX) + courriel
 *     en parallèle (filet de sécurité + démarrage du mini-funnel).
 *
 * Variables d'environnement requises :
 *   - RESEND_API_KEY                (secret)
 *   - SUPABASE_URL                  (texte)
 *   - SUPABASE_SERVICE_ROLE_KEY     (secret)
 *   - IP_HASH_SECRET                (secret) — sert AUSSI à signer les tokens
 *   - SITE_URL                      (texte)  — pour construire l'URL de téléchargement
 */

const DEFAULT_FROM = 'Vector <support@mail.vectorplanning.ai>';
const DEFAULT_REPLY_TO = 'support@vectorplanning.ai';

// Durée de validité du token de téléchargement
const TOKEN_TTL_DAYS = 30;


/**
 * Table centralisée des lead magnets.
 * Pour ajouter un nouvel ebook :
 *   1. Uploader les PDF dans /ebooks/ (avec un nom contenant un hash aléatoire)
 *   2. Ajouter une entrée ici (key = valeur de source_form envoyée par le formulaire)
 *   3. Aucune autre modification nécessaire
 *
 * Note : Option B (PdC) — le lien pointe toujours vers la version courante.
 * Pour publier v2 d'un ebook, remplacer simplement le filename dans cette table.
 * Les anciens tokens continueront de fonctionner et pointeront vers la nouvelle version.
 */
const LEAD_MAGNETS = {
    'ebook_anti_surprise': {
        title_fr: 'Le système anti-surprise',
        title_en: 'The anti-surprise system',
        subtitle_fr: '5 étapes pour solopreneurs qui jonglent plusieurs projets',
        subtitle_en: '5 steps for solopreneurs juggling multiple projects',
        file_fr: 'anti-surprise-v1-fr-a8d3f2.pdf',
        file_en: 'anti-surprise-v1-en-b9c4e1.pdf',
        download_filename_fr: 'Vector-Systeme-anti-surprise.pdf',
        download_filename_en: 'Vector-Anti-surprise-System.pdf'
    },
    'ebook_vendre_sans_travestir': {
        title_fr: 'Vendre sans te travestir',
        title_en: 'Selling Without Faking It',
        subtitle_fr: 'La méthode en 5 mouvements pour vendre en introverti',
        subtitle_en: 'The method in 5 moves to sell as an introvert',
        file_fr: 'vendre-sans-travestir-v1-fr-bb118b.pdf',
        file_en: 'vendre-sans-travestir-v1-en-38eb0b.pdf',
        download_filename_fr: 'Vector-Vendre-sans-te-travestir.pdf',
        download_filename_en: 'Vector-Selling-Without-Faking-It.pdf'
    },
    'ebook_imprevu_sante': {
        title_fr: "Préparer l'imprévu de santé",
        title_en: 'Planning for Unplanned Sick Days',
        subtitle_fr: "Le filet en 4 pièces pour t'arrêter deux jours sans que tout s'écroule",
        subtitle_en: 'The four-piece net that lets you stop for two days without everything collapsing',
        file_fr: 'imprevu-sante-v1-fr-e975c4.pdf',
        file_en: 'imprevu-sante-v1-en-df1947.pdf',
        download_filename_fr: 'Vector-Preparer-l-imprevu-de-sante.pdf',
        download_filename_en: 'Vector-Planning-for-Unplanned-Sick-Days.pdf'
    }
    // Futurs lead magnets ici. Exemple :
    // 'checklist_delegation': {
    //     title_fr: 'Checklist de délégation',
    //     ...
    // }
};


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
        // Nullable : tolère les pages/JS en cache d'avant l'ajout du champ
        const lastName = typeof data.last_name === 'string' ? (data.last_name.trim().slice(0, 80) || null) : null;
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        const lang = data.lang === 'en' ? 'en' : 'fr';
        const consentMarketing = data.consent_marketing === true;
        const sourceForm = typeof data.source_form === 'string'
            ? data.source_form.trim()
            : 'ebook_anti_surprise';  // défaut rétrocompatible
        const sourceArticle = typeof data.source_article === 'string'
            ? data.source_article.trim().slice(0, 200)
            : null;
        const sourceUrl = typeof data.source_url === 'string'
            ? data.source_url.trim().slice(0, 500)
            : null;

        // Attribution UTM (premier-touch session, propagée depuis sessionStorage). Bloc 1.5.
        const utm = pickUtm(data);

        if (!name || name.length > 80) return jsonError('Invalid name', 400);
        if (!email || email.length > 180 || !isValidEmail(email)) return jsonError('Invalid email', 400);

        // Résolution du lead magnet
        const magnet = LEAD_MAGNETS[sourceForm];
        if (!magnet) {
            console.error(`Unknown lead magnet: ${sourceForm}`);
            return jsonError('Unknown resource', 400);
        }

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

        const insertPayload = Object.assign({
            name: name,
            last_name: lastName,
            email: email,
            lang: lang,
            source_form: sourceForm,
            source_article: sourceArticle,
            source_url: sourceUrl,
            consent_marketing: consentMarketing,
            consent_ip_hash: ipHash,
            consent_user_agent_hash: uaHash
        }, utm);

        const insertRes = await fetch(
            `${env.SUPABASE_URL}/rest/v1/marketing_leads`,
            {
                method: 'POST',
                headers: supabaseHeaders,
                body: JSON.stringify(insertPayload)
            }
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

        // ── 5. Génération du token de téléchargement signé ────────────
        const downloadToken = await generateDownloadToken({
            leadId: lead.id,
            resourceKey: sourceForm,
            lang: lang,
            secret: env.IP_HASH_SECRET
        });

        const siteUrl = env.SITE_URL || 'https://vectorplanning.ai';
        const downloadUrl = `${siteUrl}/api/download?token=${encodeURIComponent(downloadToken)}`;
        const unsubUrl = `${siteUrl}/api/unsubscribe?token=${lead.unsubscribe_token}&lang=${lang}`;

        // ── 6. Envoi du courriel J+0 en parallèle ────────────────────
        const emailPromise = sendDeliveryEmail({
            env,
            lang,
            name,
            email,
            magnet,
            downloadUrl,
            unsubUrl,
            consentMarketing,
            leadId: lead.id,
            supabaseHeaders
        });

        context.waitUntil(emailPromise);

        // ── 7. Réponse immédiate au client ────────────────────────────
        return new Response(JSON.stringify({
            success: true,
            download_url: downloadUrl,
            filename: lang === 'en' ? magnet.download_filename_en : magnet.download_filename_fr,
            title: lang === 'en' ? magnet.title_en : magnet.title_fr
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        console.error('Unexpected error in ebook-request:', err);
        return jsonError('Internal error', 500);
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Envoi du courriel de livraison
// ──────────────────────────────────────────────────────────────────────────

async function sendDeliveryEmail({ env, lang, name, email, magnet, downloadUrl, unsubUrl, consentMarketing, leadId, supabaseHeaders }) {
    const safeName = escapeHtml(name);
    const isEn = lang === 'en';

    const subject = isEn
        ? `Your free guide: ${magnet.title_en}`
        : `Ton guide gratuit : ${magnet.title_fr}`;

    const html = isEn
        ? buildEmailEN(safeName, magnet, downloadUrl, unsubUrl, consentMarketing)
        : buildEmailFR(safeName, magnet, downloadUrl, unsubUrl, consentMarketing);
    const text = isEn
        ? buildTextEN(name, magnet, downloadUrl, unsubUrl, consentMarketing)
        : buildTextFR(name, magnet, downloadUrl, unsubUrl, consentMarketing);

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
        await fetch(
            `${env.SUPABASE_URL}/rest/v1/marketing_leads?id=eq.${leadId}`,
            {
                method: 'PATCH',
                headers: supabaseHeaders,
                body: JSON.stringify({
                    funnel_email_1_sent_at: nowIso,
                    last_email_sent_at: nowIso,
                    last_email_kind: 'ebook_delivery'
                })
            }
        );
    } catch (err) {
        console.error('Email sending failed (non-blocking):', err);
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Génération de token signé HMAC-SHA256
// ──────────────────────────────────────────────────────────────────────────

async function generateDownloadToken({ leadId, resourceKey, lang, secret }) {
    const payload = {
        l: leadId,
        r: resourceKey,
        lg: lang,
        e: Math.floor(Date.now() / 1000) + (TOKEN_TTL_DAYS * 86400)
    };
    const payloadJson = JSON.stringify(payload);
    const payloadB64 = base64urlEncode(payloadJson);

    const sigBuf = await hmacSha256(payloadB64, secret);
    const sigB64 = base64urlEncode(new Uint8Array(sigBuf));

    return `${payloadB64}.${sigB64}`;
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

// Extrait utm_* + referer_url d'un corps de requête, en chaînes bornées. Bloc 1.5.
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

async function hmacSha256(message, secret) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

function base64urlEncode(input) {
    let bytes;
    if (typeof input === 'string') {
        bytes = new TextEncoder().encode(input);
    } else {
        bytes = input;
    }
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}


// ──────────────────────────────────────────────────────────────────────────
// Templates email — FR
// ──────────────────────────────────────────────────────────────────────────

const EMAIL_SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// Gabarit de marque commun (en-tête logo + pied). Logo = image hébergée (Gmail ignore le SVG).
function emailShell(lang, bodyHtml, footerHtml) {
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
        <tr><td style="padding:32px;color:#1a1f2e;font-size:16px;line-height:1.65;font-family:${EMAIL_SANS};">
${bodyHtml}
        </td></tr>
        <tr><td style="padding:0 32px 28px;font-family:${EMAIL_SANS};">
          <div style="border-top:1px solid #ececec;padding-top:16px;font-size:12px;color:#6b7290;line-height:1.55;">${footerHtml}</div>
        </td></tr>
      </table>
      <div style="font-family:${EMAIL_SANS};font-size:11px;color:#9aa1b3;margin-top:16px;">Vector · vectorplanning.ai</div>
    </td></tr>
  </table>
</body>
</html>`;
}

// Bouton CTA lime
function ctaButton(href, label) {
    return `          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:1.8rem auto;"><tr>
            <td style="border-radius:10px;background:#8BFF3C;">
              <a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:15px 30px;font-family:${EMAIL_SANS};font-size:15px;font-weight:700;color:#10131A;text-decoration:none;border-radius:10px;">${label}</a>
            </td>
          </tr></table>`;
}

function buildEmailFR(name, magnet, downloadUrl, unsubUrl, consentMarketing) {
    const unsubLink = `<div style="margin-top:12px;"><a href="${unsubUrl}" style="color:#6b7290;text-decoration:underline;">Se désinscrire en un clic</a></div>`;
    const footer = consentMarketing
        ? `Tu reçois ce courriel parce que tu as téléchargé un guide sur vectorplanning.ai. Tu as aussi accepté de recevoir nos conseils de planification par courriel (max 1 par semaine).${unsubLink}`
        : `Tu reçois ce courriel parce que tu as téléchargé un guide sur vectorplanning.ai. Nous t'enverrons au maximum trois courriels de suivi liés à ce guide sur les 14 prochains jours.${unsubLink}`;
    const body =
`          <p style="margin:0 0 1.2rem;">Bonjour ${name},</p>
          <p style="margin:0 0 1.2rem;">Tu as déjà téléchargé ton guide directement après avoir rempli le formulaire — mais comme promis, je t'envoie aussi le lien par courriel pour que tu puisses le retrouver facilement plus tard.</p>
          <p style="margin:0 0 0.3rem;"><strong>${escapeHtml(magnet.title_fr)}</strong></p>
          <p style="margin:0;color:#6b7290;">${escapeHtml(magnet.subtitle_fr)}</p>
${ctaButton(downloadUrl, 'Télécharger le guide (PDF)')}
          <p style="margin:0 0 1.2rem;">Lis-le cette semaine — il est conçu pour être appliqué, pas étudié. Garde un crayon proche, il y a trois petits exercices au fil de la lecture.</p>
          <p style="margin:0 0 1.2rem;">Si tu as une question ou un commentaire après l'avoir lu, réponds simplement à ce courriel. Je le lis.</p>
          <p style="margin:0 0 0.3rem;">Bonne lecture,</p>
          <p style="margin:0;"><strong>Chantal</strong> · Vector</p>`;
    return emailShell('fr', body, footer);
}

function buildTextFR(name, magnet, downloadUrl, unsubUrl, consentMarketing) {
    const note = consentMarketing
        ? `Tu reçois ce courriel parce que tu as téléchargé un guide sur vectorplanning.ai. Tu as aussi accepté de recevoir nos conseils de planification par courriel (max 1 par semaine).\n\nSe désinscrire : ${unsubUrl}`
        : `Tu reçois ce courriel parce que tu as téléchargé un guide sur vectorplanning.ai. Nous t'enverrons au maximum trois courriels de suivi liés à ce guide sur les 14 prochains jours.\n\nSe désinscrire : ${unsubUrl}`;

    return `Bonjour ${name},

Tu as déjà téléchargé ton guide directement après avoir rempli le formulaire — mais comme promis, je t'envoie aussi le lien par courriel pour que tu puisses le retrouver facilement plus tard.

${magnet.title_fr}
${magnet.subtitle_fr}

Télécharger le guide (PDF) : ${downloadUrl}

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

function buildEmailEN(name, magnet, downloadUrl, unsubUrl, consentMarketing) {
    const unsubLink = `<div style="margin-top:12px;"><a href="${unsubUrl}" style="color:#6b7290;text-decoration:underline;">Unsubscribe in one click</a></div>`;
    const footer = consentMarketing
        ? `You're receiving this email because you downloaded a guide on vectorplanning.ai. You also opted in to receive our planning tips (max 1 per week).${unsubLink}`
        : `You're receiving this email because you downloaded a guide on vectorplanning.ai. We'll send you at most three follow-up emails related to this guide over the next 14 days.${unsubLink}`;
    const body =
`          <p style="margin:0 0 1.2rem;">Hello ${name},</p>
          <p style="margin:0 0 1.2rem;">You already downloaded your guide right after filling out the form — but as promised, I'm also sending you the link by email so you can find it easily later.</p>
          <p style="margin:0 0 0.3rem;"><strong>${escapeHtml(magnet.title_en)}</strong></p>
          <p style="margin:0;color:#6b7290;">${escapeHtml(magnet.subtitle_en)}</p>
${ctaButton(downloadUrl, 'Download the guide (PDF)')}
          <p style="margin:0 0 1.2rem;">Read it this week — it's built to be applied, not studied. Keep a pen nearby; there are three small exercises along the way.</p>
          <p style="margin:0 0 1.2rem;">If you have any question or comment after reading it, just reply to this email. I read every one.</p>
          <p style="margin:0 0 0.3rem;">Happy reading,</p>
          <p style="margin:0;"><strong>Chantal</strong> · Vector</p>`;
    return emailShell('en', body, footer);
}

function buildTextEN(name, magnet, downloadUrl, unsubUrl, consentMarketing) {
    const note = consentMarketing
        ? `You're receiving this email because you downloaded a guide on vectorplanning.ai. You also opted in to receive our planning tips (max 1 per week).\n\nUnsubscribe: ${unsubUrl}`
        : `You're receiving this email because you downloaded a guide on vectorplanning.ai. We'll send you at most three follow-up emails related to this guide over the next 14 days.\n\nUnsubscribe: ${unsubUrl}`;

    return `Hello ${name},

You already downloaded your guide right after filling out the form — but as promised, I'm also sending you the link by email so you can find it easily later.

${magnet.title_en}
${magnet.subtitle_en}

Download the guide (PDF): ${downloadUrl}

Read it this week — it's built to be applied, not studied. Keep a pen nearby; there are three small exercises along the way.

If you have any question or comment after reading it, just reply to this email. I read every one.

Happy reading,
Chantal · Vector

---
${note}`;
}
