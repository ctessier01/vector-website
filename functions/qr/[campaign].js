/**
 * Cloudflare Pages Function — GET /qr/<campagne>
 *
 * Compteur de scan de QR, côté serveur (imblocable, s'exécute AVANT tout
 * JavaScript du navigateur, donc non affecté par les bloqueurs de pub / les
 * navigateurs intégrés qui font sauter le ping d'analytics client).
 *
 * Pipeline :
 *   1. Résout la destination réelle depuis public.qr_campaigns (target_url).
 *      Repli : URL reconstruite (utm préservés) si la base ne répond pas.
 *   2. Enregistre le scan dans public.qr_scans (non bloquant), sauf bots/preview.
 *   3. Redirige en 302 (non caché) vers la destination, UTM + ancre inclus.
 *
 * Le QR encode https://vectorplanning.ai/qr/<campagne> ; la ligne qr_campaigns
 * correspondante porte le target_url final (page + UTM + #early-access).
 *
 * Env requis (déjà configurés) : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IP_HASH_SECRET.
 */

const SITE = 'https://vectorplanning.ai';
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|embedly|whatsapp|telegram|slackbot|discord|linkedinbot|twitterbot|pinterest|redditbot|preview|prefetch|monitor|headless|lighthouse|curl|wget|python-requests|axios|go-http/i;

export async function onRequest(context) {
    const { request, env, params } = context;

    // campagne = segment d'URL, borné à [a-z0-9-]
    const campaign = String(params.campaign || '')
        .toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120);

    const ua = request.headers.get('User-Agent') || '';
    const isBot = !ua || BOT_RE.test(ua);

    // 1) Destination : d'abord le registre, sinon une URL reconstruite (UTM préservés)
    let target = campaign
        ? `${SITE}/?utm_source=reseautage&utm_medium=qr&utm_campaign=${encodeURIComponent(campaign)}#early-access`
        : `${SITE}/#early-access`;

    if (campaign && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 1500);
            const r = await fetch(
                `${env.SUPABASE_URL}/rest/v1/qr_campaigns?select=target_url&campaign=eq.${encodeURIComponent(campaign)}&limit=1`,
                { headers: sbHeaders(env), signal: ctrl.signal }
            );
            clearTimeout(t);
            if (r.ok) {
                const rows = await r.json().catch(() => []);
                if (Array.isArray(rows) && rows[0] && rows[0].target_url) target = rows[0].target_url;
            }
        } catch (e) {
            // repli sur l'URL reconstruite ci-dessus
        }
    }

    // 2) Enregistrement du scan (non bloquant), uniquement pour de vrais visiteurs
    if (request.method === 'GET' && campaign) {
        context.waitUntil(recordScan({ env, request, campaign, ua, isBot }));
    }

    // 3) Redirection 302, non cachée (chaque scan doit atteindre la fonction)
    return new Response(null, {
        status: 302,
        headers: {
            'Location': target,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Referrer-Policy': 'no-referrer'
        }
    });
}

function sbHeaders(env) {
    return {
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
    };
}

async function recordScan({ env, request, campaign, ua, isBot }) {
    try {
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
        const ip = request.headers.get('CF-Connecting-IP')
            || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || '';
        const country = (request.cf && request.cf.country) || null;
        const ipHash = ip && env.IP_HASH_SECRET ? await saltedSha256(ip, env.IP_HASH_SECRET) : null;
        const uaHash = ua && env.IP_HASH_SECRET ? await saltedSha256(ua, env.IP_HASH_SECRET) : null;
        await fetch(`${env.SUPABASE_URL}/rest/v1/qr_scans`, {
            method: 'POST',
            headers: Object.assign(sbHeaders(env), { 'Prefer': 'return=minimal' }),
            body: JSON.stringify({ campaign, ip_hash: ipHash, ua_hash: uaHash, country, is_bot: isBot })
        });
    } catch (e) {
        // non bloquant : ne jamais empêcher la redirection
    }
}

async function saltedSha256(input, secret) {
    const today = new Date().toISOString().slice(0, 10);
    const data = new TextEncoder().encode(`${input}|${secret}|${today}`);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}
