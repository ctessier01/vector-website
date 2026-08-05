/**
 * Cloudflare Pages Function — GET /api/download?token=...  (Phase 1A)
 *
 * Sert le PDF d'un lead magnet après vérification du token signé HMAC-SHA256
 * généré par /api/ebook-request. Le token est lié à un lead spécifique et
 * à une ressource spécifique ; il expire après TOKEN_TTL_DAYS jours.
 *
 * Pipeline :
 *   1. Extraction et décodage du token
 *   2. Vérification de la signature HMAC (constant-time comparison)
 *   3. Vérification de l'expiration
 *   4. Résolution de la ressource via la table LEAD_MAGNETS
 *   5. Fetch du PDF depuis les assets statiques de Cloudflare Pages
 *   6. Stream du PDF au client avec les bons headers
 *   7. Incrément non-bloquant du compteur dans Supabase
 *
 * Sécurité :
 *   - Token signé : un visiteur ne peut pas fabriquer un token sans IP_HASH_SECRET
 *   - PDF stockés dans /ebooks/ avec noms obscurs (hash inclus) — Solution A
 *   - Le binding `env.ASSETS` permet de lire les fichiers statiques en interne
 *     SANS qu'ils soient nécessairement accessibles à l'URL publique directe
 *     (Cloudflare Pages les sert quand même publiquement, mais via leur URL
 *     obscure ils ne sont pas devinables)
 *
 * Variables d'environnement requises :
 *   - SUPABASE_URL                  (texte)
 *   - SUPABASE_SERVICE_ROLE_KEY     (secret)  — pour l'incrément du compteur
 *   - IP_HASH_SECRET                (secret)  — pour vérifier la signature
 *   - SITE_URL                      (texte)   — pour fetch les PDF en interne
 */

const TOKEN_TTL_DAYS = 30;

/**
 * Table centralisée des lead magnets — DOIT être identique à celle de
 * ebook-request.js. Si tu ajoutes/modifies un magnet, mets à jour les DEUX.
 *
 * (Pourquoi pas un fichier partagé ? Cloudflare Pages Functions n'ont pas
 * de système d'imports cross-Function fiable au moment de l'écriture.
 * La duplication est minime et le risque de divergence est faible parce
 * que seul le champ `file_*` est strictement nécessaire ici.)
 */
const LEAD_MAGNETS = {
    'ebook_anti_surprise': {
        file_fr: 'anti-surprise-v1-fr-a8d3f2.pdf',
        file_en: 'anti-surprise-v1-en-b9c4e1.pdf',
        download_filename_fr: 'Vector-Systeme-anti-surprise.pdf',
        download_filename_en: 'Vector-Anti-surprise-System.pdf'
    },
    'ebook_vendre_sans_travestir': {
        file_fr: 'vendre-sans-travestir-v1-fr-bb118b.pdf',
        file_en: 'vendre-sans-travestir-v1-en-38eb0b.pdf',
        download_filename_fr: 'Vector-Vendre-sans-te-travestir.pdf',
        download_filename_en: 'Vector-Selling-Without-Faking-It.pdf'
    },
    'ebook_imprevu_sante': {
        file_fr: 'imprevu-sante-v1-fr-e975c4.pdf',
        file_en: 'imprevu-sante-v1-en-df1947.pdf',
        download_filename_fr: 'Vector-Preparer-l-imprevu-de-sante.pdf',
        download_filename_en: 'Vector-Planning-for-Unplanned-Sick-Days.pdf'
    }
    // Synchroniser avec ebook-request.js
};


export async function onRequestGet(context) {
    const { request, env } = context;

    try {
        // ── 1. Extraction du token ────────────────────────────────────
        const url = new URL(request.url);
        const token = url.searchParams.get('token');

        if (!token) {
            return errorPage('missing_token', 400);
        }

        // ── 2. Vérification de la configuration ───────────────────────
        const requiredEnv = ['IP_HASH_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SITE_URL'];
        for (const k of requiredEnv) {
            if (!env[k]) {
                console.error(`Missing env var: ${k}`);
                return errorPage('server_error', 500);
            }
        }

        // ── 3. Décodage et vérification du token ──────────────────────
        const verified = await verifyToken(token, env.IP_HASH_SECRET);

        if (!verified.valid) {
            console.warn(`Invalid token: ${verified.reason}`);
            const code = verified.reason === 'expired' ? 'expired_token' : 'invalid_token';
            return errorPage(code, 403);
        }

        const { leadId, resourceKey, lang } = verified.payload;

        // ── 4. Résolution de la ressource ─────────────────────────────
        const magnet = LEAD_MAGNETS[resourceKey];
        if (!magnet) {
            console.error(`Unknown resource in token: ${resourceKey}`);
            return errorPage('unknown_resource', 404);
        }

        const filename = lang === 'en' ? magnet.file_en : magnet.file_fr;
        const downloadName = lang === 'en' ? magnet.download_filename_en : magnet.download_filename_fr;

        // ── 5. Fetch du PDF ───────────────────────────────────────────
        // On utilise env.ASSETS si disponible (binding Cloudflare), sinon
        // fallback sur fetch HTTP à l'URL publique du site (qui passe par
        // le edge Cloudflare et donc reste rapide).
        let pdfResponse;
        if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
            // Binding direct aux assets statiques (privé)
            const assetReq = new Request(`https://internal/ebooks/${filename}`);
            pdfResponse = await env.ASSETS.fetch(assetReq);
        } else {
            // Fallback : fetch HTTP public
            pdfResponse = await fetch(`${env.SITE_URL}/ebooks/${filename}`);
        }

        if (!pdfResponse.ok) {
            console.error(`PDF fetch failed for ${filename}: ${pdfResponse.status}`);
            return errorPage('file_not_found', 404);
        }

        // ── 6. Incrément du compteur (non-bloquant) ───────────────────
        const incrementPromise = incrementDownloadCount({
            env,
            leadId
        });
        context.waitUntil(incrementPromise);

        // ── 7. Stream du PDF au client ────────────────────────────────
        const headers = new Headers();
        headers.set('Content-Type', 'application/pdf');
        headers.set('Content-Disposition', `attachment; filename="${downloadName}"`);
        headers.set('Cache-Control', 'private, no-store');
        headers.set('X-Robots-Tag', 'noindex, nofollow');

        // Propager le Content-Length s'il est connu
        const contentLength = pdfResponse.headers.get('Content-Length');
        if (contentLength) headers.set('Content-Length', contentLength);

        return new Response(pdfResponse.body, {
            status: 200,
            headers: headers
        });

    } catch (err) {
        console.error('Unexpected error in download:', err);
        return errorPage('server_error', 500);
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Vérification du token HMAC
// ──────────────────────────────────────────────────────────────────────────

/**
 * Vérifie le token signé.
 * Format attendu : base64url(payload).base64url(signature)
 *
 * Retourne :
 *   { valid: true, payload: {l, r, lg, e} }
 *   { valid: false, reason: 'malformed' | 'bad_signature' | 'expired' | 'invalid_payload' }
 */
async function verifyToken(token, secret) {
    if (typeof token !== 'string' || !token.includes('.')) {
        return { valid: false, reason: 'malformed' };
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
        return { valid: false, reason: 'malformed' };
    }

    const [payloadB64, sigB64] = parts;

    // Recalculer la signature attendue
    let expectedSigBuf;
    try {
        expectedSigBuf = await hmacSha256(payloadB64, secret);
    } catch (err) {
        console.error('HMAC compute failed:', err);
        return { valid: false, reason: 'server_error' };
    }
    const expectedSigB64 = base64urlEncode(new Uint8Array(expectedSigBuf));

    // Comparaison à temps constant
    if (!constantTimeEqual(sigB64, expectedSigB64)) {
        return { valid: false, reason: 'bad_signature' };
    }

    // Décoder le payload
    let payload;
    try {
        const payloadJson = base64urlDecode(payloadB64);
        payload = JSON.parse(payloadJson);
    } catch {
        return { valid: false, reason: 'invalid_payload' };
    }

    if (!payload?.l || !payload?.r || !payload?.lg || !payload?.e) {
        return { valid: false, reason: 'invalid_payload' };
    }

    // Vérifier l'expiration
    const nowUnix = Math.floor(Date.now() / 1000);
    if (nowUnix > payload.e) {
        return { valid: false, reason: 'expired' };
    }

    return {
        valid: true,
        payload: {
            leadId: payload.l,
            resourceKey: payload.r,
            lang: payload.lg,
            expiry: payload.e
        }
    };
}


// ──────────────────────────────────────────────────────────────────────────
// Incrément du compteur de téléchargements
// ──────────────────────────────────────────────────────────────────────────

async function incrementDownloadCount({ env, leadId }) {
    try {
        const supabaseHeaders = {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        };

        // Récupérer le compteur actuel
        const getRes = await fetch(
            `${env.SUPABASE_URL}/rest/v1/marketing_leads?id=eq.${leadId}&select=download_count`,
            { headers: supabaseHeaders }
        );

        if (!getRes.ok) {
            console.error('Counter fetch failed:', getRes.status);
            return;
        }

        const rows = await getRes.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            console.error(`Lead ${leadId} not found for counter update`);
            return;
        }

        const currentCount = rows[0].download_count || 0;

        // Incrémenter
        const patchRes = await fetch(
            `${env.SUPABASE_URL}/rest/v1/marketing_leads?id=eq.${leadId}`,
            {
                method: 'PATCH',
                headers: supabaseHeaders,
                body: JSON.stringify({
                    download_count: currentCount + 1,
                    last_downloaded_at: new Date().toISOString()
                })
            }
        );

        if (!patchRes.ok) {
            const errBody = await patchRes.text().catch(() => '');
            console.error('Counter increment failed:', patchRes.status, errBody);
        }
    } catch (err) {
        console.error('Counter update exception:', err);
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Helpers crypto
// ──────────────────────────────────────────────────────────────────────────

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

function base64urlDecode(s) {
    // Restaurer le padding et les caractères standards
    let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

/**
 * Comparaison à temps constant pour prévenir les attaques temporelles
 * sur la vérification de signature.
 */
function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}


// ──────────────────────────────────────────────────────────────────────────
// Pages d'erreur (UI brandée)
// ──────────────────────────────────────────────────────────────────────────

const ERROR_MESSAGES = {
    missing_token: {
        title_fr: 'Lien incomplet',
        title_en: 'Incomplete link',
        body_fr: 'Le lien que tu as utilisé semble incomplet. Vérifie que tu as copié l\'URL en entier, ou retourne dans le courriel pour cliquer le bouton de téléchargement.',
        body_en: 'The link you used appears to be incomplete. Check that you copied the full URL, or go back to the email to click the download button.'
    },
    invalid_token: {
        title_fr: 'Lien invalide',
        title_en: 'Invalid link',
        body_fr: 'Ce lien de téléchargement ne semble pas valide. Si tu continues à voir cette erreur, écris-nous à support@vectorplanning.ai et nous t\'enverrons le guide manuellement.',
        body_en: 'This download link doesn\'t appear to be valid. If you continue to see this error, write to us at support@vectorplanning.ai and we\'ll send you the guide manually.'
    },
    expired_token: {
        title_fr: 'Lien expiré',
        title_en: 'Expired link',
        body_fr: 'Ce lien de téléchargement a expiré (la validité est de 30 jours). Pour obtenir un nouveau lien, retourne sur la page où tu avais demandé le guide et remplis à nouveau le formulaire.',
        body_en: 'This download link has expired (validity is 30 days). To get a new link, return to the page where you requested the guide and fill out the form again.'
    },
    unknown_resource: {
        title_fr: 'Ressource introuvable',
        title_en: 'Resource not found',
        body_fr: 'La ressource demandée n\'existe plus ou a été déplacée. Écris-nous à support@vectorplanning.ai pour qu\'on t\'aide.',
        body_en: 'The requested resource no longer exists or has been moved. Write to support@vectorplanning.ai for help.'
    },
    file_not_found: {
        title_fr: 'Fichier introuvable',
        title_en: 'File not found',
        body_fr: 'Le fichier que tu demandes est temporairement indisponible. Réessaie dans quelques minutes, ou écris-nous à support@vectorplanning.ai.',
        body_en: 'The file you requested is temporarily unavailable. Try again in a few minutes, or write to support@vectorplanning.ai.'
    },
    server_error: {
        title_fr: 'Erreur temporaire',
        title_en: 'Temporary error',
        body_fr: 'Une erreur technique est survenue. Réessaie dans quelques minutes, ou écris-nous à support@vectorplanning.ai si le problème persiste.',
        body_en: 'A technical error occurred. Try again in a few minutes, or write to support@vectorplanning.ai if the issue persists.'
    }
};

function errorPage(code, status) {
    const lang = 'fr'; // Par défaut FR pour les pages d'erreur (le lang du token n'est pas accessible si le token est invalide)
    const msg = ERROR_MESSAGES[code] || ERROR_MESSAGES.server_error;
    const title = msg[`title_${lang}`];
    const body = msg[`body_${lang}`];

    const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — Vector</title>
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
    border-bottom: 2px solid #6B7290;
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
    <div class="icon">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="10" stroke="#6B7290" stroke-width="2"/>
        <path d="M12 8v5M12 16h.01" stroke="#6B7290" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(body)}</p>
    <a class="back-link" href="https://vectorplanning.ai">← Retour à vectorplanning.ai</a>
  </main>
</body>
</html>`;

    return new Response(html, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow'
        }
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}
