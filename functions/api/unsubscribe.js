/**
 * Cloudflare Pages Function — /api/unsubscribe
 *
 * Désabonnement en un clic via le token unique. Couvre DEUX tables de leads :
 * vw_marketing_leads (ebooks) et vw_early_adopter_leads (liste d'attente, Bloc 1.5).
 * Le token est essayé dans chaque table jusqu'à correspondance.
 *
 * Deux modes :
 *   GET  /api/unsubscribe?token=...&lang=fr|en
 *     → affiche une page HTML de confirmation et désabonne immédiatement
 *       (un clic = action irréversible, conforme à la LCAP et à RFC 8058)
 *
 *   POST /api/unsubscribe  (avec corps "List-Unsubscribe=One-Click", RFC 8058)
 *     → désabonnement automatique déclenché par Gmail/Yahoo via en-tête
 *       List-Unsubscribe-Post du courriel. Aucun affichage.
 *
 * Idempotent : appeler 2 fois = pas d'erreur, juste le même statut final.
 *
 * Variables d'environnement requises :
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 */


export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'fr';

    if (!token || !/^[a-f0-9]{8,96}$/i.test(token)) {
        return htmlResponse(renderErrorPage(lang, 'invalid_token'), 400);
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('Missing Supabase env vars');
        return htmlResponse(renderErrorPage(lang, 'server_error'), 500);
    }

    const result = await unsubscribeByToken(env, token);

    if (result === 'not_found') {
        return htmlResponse(renderErrorPage(lang, 'not_found'), 404);
    }
    if (result === 'error') {
        return htmlResponse(renderErrorPage(lang, 'server_error'), 500);
    }

    // Succès ('unsubscribed' ou 'already')
    return htmlResponse(renderSuccessPage(lang, result === 'already'), 200);
}


export async function onRequestPost(context) {
    // RFC 8058 : Gmail/Yahoo envoient POST avec corps "List-Unsubscribe=One-Click"
    // pour le désabonnement automatique. On répond 200 sans HTML.
    const { request, env } = context;
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token || !/^[a-f0-9]{8,96}$/i.test(token)) {
        return new Response('Invalid token', { status: 400 });
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('Missing Supabase env vars');
        return new Response('Server error', { status: 500 });
    }

    const result = await unsubscribeByToken(env, token);

    if (result === 'not_found') return new Response('Not found', { status: 404 });
    if (result === 'error')     return new Response('Server error', { status: 500 });

    return new Response('OK', { status: 200 });
}


// ──────────────────────────────────────────────────────────────────────────
// Logique de désabonnement
// ──────────────────────────────────────────────────────────────────────────

/**
 * Effectue le désabonnement.
 * Retourne 'unsubscribed' (succès, premier désabonnement),
 *         'already' (déjà désabonné — succès idempotent),
 *         'not_found' (token inconnu),
 *         'error' (Supabase down ou autre).
 */
// Tables porteuses d'un unsubscribe_token. `extra` = colonnes à mettre à jour
// en plus de status/unsubscribed_at (vw_marketing_leads a consent_marketing).
const LEAD_TABLES = [
    { name: 'vw_marketing_leads',      extra: { consent_marketing: false } },
    { name: 'vw_early_adopter_leads',  extra: {} },
    { name: 'coo_waitlist_leads',       extra: { consent_marketing: false } }
];

async function unsubscribeByToken(env, token) {
    const headers = {
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
    };

    let foundButInactive = false;

    try {
        for (const tbl of LEAD_TABLES) {
            // PATCH conditionnel : ne change que si status='active'.
            const patchRes = await fetch(
                `${env.SUPABASE_URL}/rest/v1/${tbl.name}?unsubscribe_token=eq.${encodeURIComponent(token)}&status=eq.active`,
                {
                    method: 'PATCH',
                    headers: headers,
                    body: JSON.stringify(Object.assign({
                        status: 'unsubscribed',
                        unsubscribed_at: new Date().toISOString()
                    }, tbl.extra))
                }
            );

            if (!patchRes.ok) {
                const body = await patchRes.text().catch(() => '');
                console.error('Supabase PATCH failed:', tbl.name, patchRes.status, body);
                return 'error';
            }

            const updated = await patchRes.json();
            if (Array.isArray(updated) && updated.length > 0) {
                return 'unsubscribed';
            }

            // Aucune ligne active : le token existe-t-il (déjà désabonné) dans cette table ?
            const getRes = await fetch(
                `${env.SUPABASE_URL}/rest/v1/${tbl.name}?unsubscribe_token=eq.${encodeURIComponent(token)}&select=status`,
                { headers: headers }
            );
            if (!getRes.ok) return 'error';

            const rows = await getRes.json();
            if (Array.isArray(rows) && rows.length > 0) foundButInactive = true;
        }

        // Parcours terminé sans PATCH actif.
        return foundButInactive ? 'already' : 'not_found';

    } catch (err) {
        console.error('unsubscribeByToken exception:', err);
        return 'error';
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Rendus HTML — page de confirmation Vector-brandée
// ──────────────────────────────────────────────────────────────────────────

function htmlResponse(html, status) {
    return new Response(html, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'X-Robots-Tag': 'noindex, nofollow'
        }
    });
}

const I18N = {
    fr: {
        title: 'Désabonnement — Vector',
        success_heading: 'C\'est fait.',
        success_body: 'Tu ne recevras plus de courriels de notre part. Merci d\'avoir lu nos contenus jusqu\'ici.',
        already_heading: 'Déjà désabonné.',
        already_body: 'Cette adresse était déjà désinscrite. Aucune action supplémentaire requise.',
        error_invalid: 'Lien invalide.',
        error_invalid_body: 'Le lien de désabonnement semble incomplet ou corrompu. Si tu continues à recevoir nos courriels, écris-nous à support@vectorplanning.ai et nous nous occuperons du désabonnement manuellement.',
        error_not_found: 'Lien introuvable.',
        error_not_found_body: 'Ce lien de désabonnement ne correspond à aucun courriel actif. C\'est probablement qu\'il a expiré ou que le compte a été supprimé. Si tu continues à recevoir nos courriels, écris-nous à support@vectorplanning.ai.',
        error_server: 'Erreur temporaire.',
        error_server_body: 'Une erreur technique est survenue. Réessaie dans quelques minutes, ou écris-nous à support@vectorplanning.ai si le problème persiste.',
        back_home: 'Retour à vectorplanning.ai →'
    },
    en: {
        title: 'Unsubscribe — Vector',
        success_heading: 'You\'re unsubscribed.',
        success_body: 'You will no longer receive emails from us. Thanks for reading our content this far.',
        already_heading: 'Already unsubscribed.',
        already_body: 'This address was already removed from our list. No further action needed.',
        error_invalid: 'Invalid link.',
        error_invalid_body: 'The unsubscribe link looks incomplete or broken. If you keep receiving our emails, write to support@vectorplanning.ai and we\'ll unsubscribe you manually.',
        error_not_found: 'Link not found.',
        error_not_found_body: 'This unsubscribe link doesn\'t match any active email. It may have expired or the record was deleted. If you keep receiving our emails, write to support@vectorplanning.ai.',
        error_server: 'Temporary error.',
        error_server_body: 'A technical error occurred. Please try again in a few minutes, or write to support@vectorplanning.ai if the issue persists.',
        back_home: 'Back to vectorplanning.ai →'
    }
};

function renderSuccessPage(lang, alreadyUnsubscribed) {
    const t = I18N[lang];
    const heading = alreadyUnsubscribed ? t.already_heading : t.success_heading;
    const body = alreadyUnsubscribed ? t.already_body : t.success_body;
    return baseHTML(lang, t.title, heading, body, true);
}

function renderErrorPage(lang, kind) {
    const t = I18N[lang];
    let heading, body;
    if (kind === 'invalid_token') { heading = t.error_invalid; body = t.error_invalid_body; }
    else if (kind === 'not_found') { heading = t.error_not_found; body = t.error_not_found_body; }
    else { heading = t.error_server; body = t.error_server_body; }
    return baseHTML(lang, t.title, heading, body, false);
}

function baseHTML(lang, title, heading, body, isSuccess) {
    const t = I18N[lang];
    const accentColor = isSuccess ? '#3D9A18' : '#6B7290';
    const iconSvg = isSuccess
        ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17l-5-5" stroke="#3D9A18" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" stroke="#6B7290" stroke-width="2"/><path d="M12 8v5M12 16h.01" stroke="#6B7290" stroke-width="2" stroke-linecap="round"/></svg>';

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Red+Hat+Display:wght@700&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after { box-sizing: border-box; }
  html,body { margin: 0; padding: 0; }
  body {
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #F5F4EF;
    color: #10131A;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1.25rem;
    line-height: 1.6;
  }
  .card {
    background: #ffffff;
    border-radius: 14px;
    max-width: 540px;
    width: 100%;
    padding: 3rem 2.5rem;
    box-shadow: 0 1px 3px rgba(16,19,26,0.05), 0 8px 24px rgba(16,19,26,0.04);
  }
  .icon { margin-bottom: 1.5rem; }
  h1 {
    font-family: 'Red Hat Display', sans-serif;
    font-weight: 700;
    font-size: 1.9rem;
    color: #10131A;
    margin: 0 0 1rem;
    border-bottom: 2px solid ${accentColor};
    padding-bottom: 0.6rem;
    display: inline-block;
  }
  p { color: #10131A; margin: 0 0 1rem; font-size: 1rem; }
  .back-link {
    display: inline-block;
    margin-top: 1.5rem;
    color: #6B7290;
    text-decoration: none;
    font-size: 0.9rem;
  }
  .back-link:hover { color: #10131A; }
  @media (max-width: 480px) {
    .card { padding: 2rem 1.5rem; }
    h1 { font-size: 1.5rem; }
  }
</style>
</head>
<body>
  <main class="card">
    <div class="icon">${iconSvg}</div>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(body)}</p>
    <a class="back-link" href="https://vectorplanning.ai">${escapeHtml(t.back_home)}</a>
  </main>
</body>
</html>`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}
