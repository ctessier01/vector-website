/**
 * Cloudflare Pages Function — POST /api/beta-nda
 *
 * Proxy sécurisé entre la page /beta-nda (navigateur) et l'Edge Function
 * `beta-nda` du projet vector-app. Garde l'Edge Function privée (secret
 * partagé) et hache l'adresse IP AU BORD (jamais transmise ni stockée en clair).
 *
 * Sécurité :
 *   - Aucune PII en cache : Cache-Control no-store sur toutes les réponses.
 *   - L'IP est hachée ici (SHA-256 PUR + pepper stable) puis transmise hachée.
 *     PAS le helper daté/tronqué du site : une preuve d'acceptation doit rester
 *     vérifiable longtemps.
 *   - Le courriel n'est jamais reçu du client : il est dérivé du jeton côté app.
 *
 * Variables d'environnement (Cloudflare Pages) :
 *   - NDA_EDGE_URL      : URL de l'Edge Function vector-app (ex. https://<ref>.supabase.co/functions/v1/beta-nda)
 *   - NDA_SHARED_SECRET : secret partagé avec l'Edge Function
 *   - NDA_IP_PEPPER     : sel stable pour le hachage IP (preuve d'acceptation)
 */

const NO_STORE = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
};

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        if (!env.NDA_EDGE_URL || !env.NDA_SHARED_SECRET) {
            console.error('beta-nda: configuration manquante (NDA_EDGE_URL / NDA_SHARED_SECRET)');
            return json({ ok: false, error: 'CONFIG' }, 500);
        }

        let data;
        try { data = await request.json(); } catch { return json({ ok: false, error: 'BAD_JSON' }, 400); }

        const action = data.action === 'accept' ? 'accept' : data.action === 'resolve' ? 'resolve' : null;
        const token = typeof data.token === 'string' ? data.token.trim() : '';
        if (!action) return json({ ok: false, error: 'BAD_ACTION' }, 400);
        if (!token || token.length > 200) return json({ ok: false, error: 'NO_TOKEN' }, 400);

        const payload = { action, token };

        if (action === 'accept') {
            payload.language_chosen = data.language_chosen === 'en' ? 'en' : 'fr';
            payload.english_consent = data.english_consent === true;

            // Hachage IP au bord : SHA-256 pur (64 hex) + pepper stable. Jamais d'IP en clair.
            const ip = request.headers.get('CF-Connecting-IP')
                || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
                || '';
            payload.ip_hash = (ip && env.NDA_IP_PEPPER) ? await sha256Hex(`${ip}|${env.NDA_IP_PEPPER}`) : null;
            payload.user_agent = (request.headers.get('User-Agent') || '').slice(0, 400);
        }

        const edgeRes = await fetch(env.NDA_EDGE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-nda-secret': env.NDA_SHARED_SECRET,
            },
            body: JSON.stringify(payload),
        });

        const bodyText = await edgeRes.text();
        // On relaie le corps + le statut de l'Edge Function, en forçant no-store.
        return new Response(bodyText, { status: edgeRes.status, headers: NO_STORE });

    } catch (err) {
        console.error('beta-nda proxy error:', err);
        return json({ ok: false, error: 'INTERNAL' }, 500);
    }
}

function json(obj, status) {
    return new Response(JSON.stringify(obj), { status, headers: NO_STORE });
}

async function sha256Hex(input) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
