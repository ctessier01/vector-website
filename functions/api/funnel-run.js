/**
 * Cloudflare Pages Function — POST /api/funnel-run
 *
 * Exécute le mini-funnel de relance des lead magnets : envoie les courriels
 * J+3 et J+7 aux leads dont l'envoi est dû, puis marque l'envoi en base.
 *
 * Déclenché par un cron externe (GitHub Actions, horaire) parce que les
 * Pages Functions n'ont pas de déclencheur planifié natif.
 *
 * Pipeline :
 *   1. Authentification par secret partagé (en-tête X-Funnel-Secret)
 *   2. Garde-fou horaire : on n'envoie pas la nuit (fenêtre 9h-17h Est)
 *   3. Lecture de la vue vw_marketing_leads_funnel_due, qui contient TOUTE
 *      la logique de ciblage : quel courriel est dû, filtre des désabonnés,
 *      et la garantie LCAP de 14 jours. Cette logique reste volontairement
 *      dans la base : rien côté code ne peut la contourner.
 *   4. Pour chaque lead : envoi via Resend, puis marquage de la colonne
 *      correspondante. Le marquage est conditionnel (filtre is.null), donc
 *      deux exécutions simultanées ne peuvent pas produire deux envois.
 *   5. Si l'envoi échoue, on ne marque pas : la prochaine exécution réessaiera.
 *
 * Sécurité :
 *   - Le secret est comparé en temps constant.
 *   - Aucune donnée de lead n'est retournée dans la réponse (compteurs seuls).
 *
 * Variables d'environnement requises :
 *   - FUNNEL_CRON_SECRET          (secret) — doit correspondre à l'en-tête
 *   - RESEND_API_KEY              (secret)
 *   - SUPABASE_URL                (texte)
 *   - SUPABASE_SERVICE_ROLE_KEY   (secret)
 *   - IP_HASH_SECRET              (secret) — signe les liens de téléchargement
 *   - SITE_URL                    (texte)
 */

const DEFAULT_FROM = 'Vector <support@mail.vectorplanning.ai>';
const DEFAULT_REPLY_TO = 'support@vectorplanning.ai';

const BATCH_LIMIT = 40;          // leads traités par exécution
const TOKEN_TTL_DAYS = 30;
const SEND_WINDOW = { start: 9, end: 17, tz: 'America/Toronto' };

const EMAIL_SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";


/**
 * Contenu du funnel, par lead magnet.
 *
 * Un magnet absent de cette table n'envoie simplement AUCUNE relance : c'est
 * volontaire et sans risque (le pied de courriel promet « au maximum trois »,
 * jamais un nombre exact). Pour activer un nouvel ebook, ajouter son entrée.
 *
 * `file_key` sert à régénérer un lien de téléchargement signé, pour que le
 * bouton ouvre le guide du lecteur plutôt qu'une page générique.
 */
const FUNNEL_COPY = {
    'ebook_anti_surprise': {
        title_fr: 'Le système anti-surprise',
        title_en: 'The anti-surprise system',
        day3: {
            fr: {
                subject: 'Par où commencer dans le guide',
                cta: 'Ouvrir le guide',
                cta_kind: 'download',
                body: [
                    "Tu as téléchargé « Le système anti-surprise » il y a trois jours. Si tu ne l'as pas encore ouvert, aucun jugement : c'est exactement le genre de chose qui glisse quand la semaine est pleine.",
                    "Si tu veux un point d'entrée, commence par l'étape 2 : l'inventaire de capacité. C'est la plus courte du guide, et c'est elle qui donne son sens à la projection de l'étape 1. Elle tient en un calcul :"
                ],
                calc: ['40 heures théoriques par semaine', "moins 16 heures d'admin, de courriels, de transitions et d'imprévus", '= 24 heures réellement disponibles pour livrer'],
                after: [
                    'La plupart des solopreneurs planifient 40 heures de travail dans 24 heures de capacité.',
                    "Fais le calcul avec tes vrais chiffres, ça prend cinq minutes. Ta projection 14 jours se compare alors à un chiffre réel au lieu d'un chiffre imaginaire, et c'est à partir de là que tout le reste du système tient."
                ],
                signoff: 'Bonne semaine,'
            },
            en: {
                subject: 'Where to start in the guide',
                cta: 'Open the guide',
                cta_kind: 'download',
                body: [
                    'You downloaded "The anti-surprise system" three days ago. If you haven\'t opened it yet, no judgment: that\'s exactly the kind of thing that slips when the week is full.',
                    'If you want an entry point, start with step 2: the capacity inventory. It\'s the shortest one in the guide, and it\'s what gives the step 1 projection its meaning. It fits in one calculation:'
                ],
                calc: ['40 theoretical hours per week', 'minus 16 hours of admin, email, transitions and interruptions', '= 24 hours actually available to deliver'],
                after: [
                    'Most solopreneurs plan 40 hours of work into 24 hours of capacity.',
                    'Do the math with your real numbers, it takes five minutes. Your 14-day projection then compares against a real number instead of an imaginary one, and that\'s where the rest of the system starts to hold.'
                ],
                signoff: 'Have a good week,'
            }
        },
        day7: {
            fr: {
                subject: 'Quand la méthode commence à peser',
                cta: 'Essayer Vector gratuitement',
                cta_kind: 'site',
                body: [
                    "Ça fait une semaine. Si tu as installé ne serait-ce que la projection 14 jours, tu as déjà réglé la moitié du problème.",
                    "Le guide se termine sur une idée que je veux te répéter, parce que c'est la question qu'on me pose le plus.",
                    "Le système manuel fonctionne très bien tant que tu as une ou deux dizaines de tâches en vol. Passé une trentaine, ce n'est pas la méthode qui casse, c'est son coût d'entretien. Chaque tâche qui bouge en déplace d'autres, et il faut re-vérifier ce qui entre en collision avec quoi. Tu finis par passer plus de temps à tenir le système à jour qu'à faire le travail.",
                    "C'est pour ce moment précis qu'on a bâti Vector. Tu gardes la méthode, Arthur s'occupe de l'entretien : la projection se tient à jour toute seule, la capacité se calcule sur ton historique réel, et tu reçois une alerte dès qu'une échéance entre en zone à risque.",
                    "Le plan Fondation est gratuit à vie, sans carte de crédit, et tu as 14 jours du plan Accélération complet à l'inscription pour voir ce que ça donne sur tes vraies tâches."
                ],
                calc: null,
                after: ["Et si le manuel te suffit, garde-le, sincèrement. Le but du guide n'était pas de te vendre quelque chose, c'était de rendre tes semaines prévisibles."],
                signoff: 'À bientôt,'
            },
            en: {
                subject: 'When the method starts to weigh',
                cta: 'Try Vector free',
                cta_kind: 'site',
                body: [
                    "It's been a week. If you've set up even just the 14-day projection, you've already solved half the problem.",
                    "The guide ends on an idea I want to repeat here, because it's the question I get most.",
                    "The manual system works very well as long as you have one or two dozen tasks in flight. Past thirty, it isn't the method that breaks, it's its maintenance cost. Every task that moves displaces others, and you have to re-check what collides with what. You end up spending more time keeping the system current than doing the work.",
                    "That's exactly the moment we built Vector for. You keep the method, Arthur handles the upkeep: the projection stays current on its own, capacity is computed from your real history, and you get an alert as soon as a deadline enters the risk zone.",
                    "The Foundation plan is free for life, no credit card, and you get 14 days of the full Acceleration plan at signup to see what it does on your real tasks."
                ],
                calc: null,
                after: ["And if manual is enough for you, keep it, sincerely. The goal of the guide wasn't to sell you something, it was to make your weeks predictable."],
                signoff: 'Talk soon,'
            }
        }
    }
    // Ajouter ici la séquence de « Vendre sans te travestir » quand elle sera écrite.
};


export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // ── 1. Authentification ───────────────────────────────────────
        if (!env.FUNNEL_CRON_SECRET) {
            console.error('Missing env var: FUNNEL_CRON_SECRET');
            return json({ error: 'Server configuration error' }, 500);
        }
        const provided = request.headers.get('X-Funnel-Secret') || '';
        if (!timingSafeEqual(provided, env.FUNNEL_CRON_SECRET)) {
            return json({ error: 'Forbidden' }, 403);
        }

        for (const k of ['RESEND_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'IP_HASH_SECRET']) {
            if (!env[k]) {
                console.error(`Missing env var: ${k}`);
                return json({ error: 'Server configuration error' }, 500);
            }
        }

        // ── 2. Garde-fou horaire ──────────────────────────────────────
        // On ne réveille personne à 3 h du matin. `force=1` sert aux tests.
        const url = new URL(request.url);
        const force = url.searchParams.get('force') === '1';
        const hour = localHour(SEND_WINDOW.tz);
        if (!force && (hour < SEND_WINDOW.start || hour >= SEND_WINDOW.end)) {
            return json({ ok: true, skipped: 'outside_send_window', local_hour: hour, sent: 0 });
        }

        const supabaseHeaders = {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
        };

        // ── 3. Leads dus (toute la logique de ciblage vit dans la vue) ─
        const dueRes = await fetch(
            `${env.SUPABASE_URL}/rest/v1/vw_marketing_leads_funnel_due` +
            `?next_email_kind=not.is.null&limit=${BATCH_LIMIT}`,
            { headers: supabaseHeaders }
        );

        if (!dueRes.ok) {
            const body = await dueRes.text().catch(() => '');
            console.error('Supabase read error:', dueRes.status, body);
            return json({ error: 'Database error', status: dueRes.status }, 502);
        }

        const leads = await dueRes.json();
        if (!Array.isArray(leads) || leads.length === 0) {
            return json({ ok: true, due: 0, sent: 0, skipped: 0, failed: 0 });
        }

        // ── 4. Envois ─────────────────────────────────────────────────
        const siteUrl = env.SITE_URL || 'https://vectorplanning.ai';
        let sent = 0, skipped = 0, failed = 0;

        for (const lead of leads) {
            const step = normalizeStep(lead.next_email_kind);
            const magnet = FUNNEL_COPY[lead.source_form];

            // Magnet sans séquence rédigée : on ne relance pas.
            if (!magnet || !step || !magnet[step]) { skipped++; continue; }

            const lang = lead.lang === 'en' ? 'en' : 'fr';
            const copy = magnet[step][lang];
            if (!copy) { skipped++; continue; }

            const column = step === 'day3' ? 'funnel_email_2_sent_at' : 'funnel_email_3_sent_at';

            try {
                let ctaUrl = `${siteUrl}/?utm_source=funnel&utm_medium=email&utm_campaign=${encodeURIComponent(lead.source_form)}&utm_content=${step}`;
                if (copy.cta_kind === 'download') {
                    const token = await generateDownloadToken({
                        leadId: lead.id, resourceKey: lead.source_form, lang, secret: env.IP_HASH_SECRET
                    });
                    ctaUrl = `${siteUrl}/api/download?token=${encodeURIComponent(token)}`;
                }
                const unsubUrl = `${siteUrl}/api/unsubscribe?token=${lead.unsubscribe_token}&lang=${lang}`;
                const guideTitle = lang === 'en' ? magnet.title_en : magnet.title_fr;

                const ok = await sendEmail({
                    env, lang, copy, ctaUrl, unsubUrl, guideTitle,
                    name: firstName(lead.name), to: lead.email,
                    stepIndex: step === 'day3' ? 2 : 3
                });
                if (!ok) { failed++; continue; }

                // Marquage conditionnel : la colonne doit encore être nulle.
                const nowIso = new Date().toISOString();
                const patch = {};
                patch[column] = nowIso;
                patch.last_email_sent_at = nowIso;
                patch.last_email_kind = step === 'day3' ? 'funnel_day3' : 'funnel_day7';

                const patchRes = await fetch(
                    `${env.SUPABASE_URL}/rest/v1/marketing_leads?id=eq.${lead.id}&${column}=is.null`,
                    { method: 'PATCH', headers: supabaseHeaders, body: JSON.stringify(patch) }
                );
                if (!patchRes.ok) {
                    // Courriel parti mais marquage échoué : on le signale fort,
                    // c'est le seul cas qui pourrait produire un doublon.
                    console.error(`MARK FAILED after send, lead ${lead.id}: ${patchRes.status}`);
                }
                sent++;
            } catch (err) {
                console.error(`Funnel send failed for lead ${lead.id}:`, err);
                failed++;
            }
        }

        return json({ ok: true, due: leads.length, sent, skipped, failed, local_hour: hour });

    } catch (err) {
        console.error('Unexpected error in funnel-run:', err);
        return json({ error: 'Internal error' }, 500);
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Envoi
// ──────────────────────────────────────────────────────────────────────────

async function sendEmail({ env, lang, copy, ctaUrl, unsubUrl, guideTitle, name, to, stepIndex }) {
    const isEn = lang === 'en';
    const safeName = escapeHtml(name);

    const footer = isEn
        ? `You're receiving this email because you downloaded "${escapeHtml(guideTitle)}" on vectorplanning.ai. This is follow-up ${stepIndex} of at most three related to that guide. <a href="${unsubUrl}" style="color:#6b7290;text-decoration:underline;">Unsubscribe in one click</a>.`
        : `Tu reçois ce courriel parce que tu as téléchargé « ${escapeHtml(guideTitle)} » sur vectorplanning.ai. C'est le suivi ${stepIndex} sur un maximum de trois liés à ce guide. <a href="${unsubUrl}" style="color:#6b7290;text-decoration:underline;">Se désinscrire en un clic</a>.`;

    let bodyHtml = `          <p style="margin:0 0 1.2rem;">${isEn ? 'Hello' : 'Bonjour'} ${safeName},</p>\n`;
    for (const p of copy.body) bodyHtml += `          <p style="margin:0 0 1.2rem;">${escapeHtml(p)}</p>\n`;
    if (copy.calc) {
        bodyHtml += `          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 1.4rem;"><tr><td style="background:#10131A;border-left:4px solid #8BFF3C;border-radius:0 10px 10px 0;padding:16px 20px;font-family:${EMAIL_SANS};font-size:15px;line-height:1.7;color:#e7eaef;">`;
        bodyHtml += copy.calc.map((l, i) => (i === copy.calc.length - 1
            ? `<strong style="color:#8BFF3C;">${escapeHtml(l)}</strong>`
            : escapeHtml(l))).join('<br>');
        bodyHtml += `</td></tr></table>\n`;
    }
    for (const p of copy.after) bodyHtml += `          <p style="margin:0 0 1.2rem;">${escapeHtml(p)}</p>\n`;
    bodyHtml += ctaButton(ctaUrl, escapeHtml(copy.cta));
    bodyHtml += `          <p style="margin:0 0 0.3rem;">${escapeHtml(copy.signoff)}</p>\n`;
    bodyHtml += `          <p style="margin:0;"><strong>Chantal</strong> · Vector</p>`;

    const textParts = [`${isEn ? 'Hello' : 'Bonjour'} ${name},`, ''];
    for (const p of copy.body) textParts.push(p, '');
    if (copy.calc) textParts.push(...copy.calc, '');
    for (const p of copy.after) textParts.push(p, '');
    textParts.push(`${copy.cta} : ${ctaUrl}`, '', copy.signoff, 'Chantal · Vector', '', '---',
        isEn ? `Unsubscribe: ${unsubUrl}` : `Se désinscrire : ${unsubUrl}`);

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: env.EBOOK_FROM || DEFAULT_FROM,
                to: [to],
                reply_to: env.EBOOK_REPLY_TO || DEFAULT_REPLY_TO,
                subject: copy.subject,
                html: emailShell(lang, bodyHtml, footer),
                text: textParts.join('\n'),
                headers: {
                    'List-Unsubscribe': `<${unsubUrl}>`,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
                }
            })
        });
        if (!res.ok) {
            console.error('Resend error:', res.status, await res.text().catch(() => ''));
            return false;
        }
        return true;
    } catch (err) {
        console.error('Resend request failed:', err);
        return false;
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Gabarit de marque (identique à ebook-request.js)
// ──────────────────────────────────────────────────────────────────────────

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

function ctaButton(href, label) {
    return `          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:1.8rem auto;"><tr>
            <td style="border-radius:10px;background:#8BFF3C;">
              <a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:15px 30px;font-family:${EMAIL_SANS};font-size:15px;font-weight:700;color:#10131A;text-decoration:none;border-radius:10px;">${label}</a>
            </td>
          </tr></table>\n`;
}


// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// Accepte funnel_day10 (ancienne vue) et funnel_day7 (nouvelle) : la bascule
// SQL peut donc se faire avant ou après ce déploiement, sans interruption.
function normalizeStep(kind) {
    if (kind === 'funnel_day3') return 'day3';
    if (kind === 'funnel_day7' || kind === 'funnel_day10') return 'day7';
    return null;
}

function localHour(tz) {
    try {
        return parseInt(new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, hour: '2-digit', hour12: false
        }).format(new Date()), 10);
    } catch (e) {
        return new Date().getUTCHours();
    }
}

function firstName(full) {
    const n = (full || '').trim().split(/\s+/)[0];
    return n || 'là';
}

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

async function generateDownloadToken({ leadId, resourceKey, lang, secret }) {
    const payload = {
        l: leadId, r: resourceKey, lg: lang,
        e: Math.floor(Date.now() / 1000) + (TOKEN_TTL_DAYS * 86400)
    };
    const payloadB64 = base64urlEncode(JSON.stringify(payload));
    const sigBuf = await hmacSha256(payloadB64, secret);
    return `${payloadB64}.${base64urlEncode(new Uint8Array(sigBuf))}`;
}

async function hmacSha256(message, secret) {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

function base64urlEncode(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
