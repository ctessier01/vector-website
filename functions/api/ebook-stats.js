/**
 * Cloudflare Pages Function — GET /api/ebook-stats?key=...
 *
 * Tableau de bord interne des lead magnets. Affiche, par ebook :
 *   - Demandes         : nombre de formulaires soumis (lignes marketing_leads)
 *   - Ont téléchargé   : leads ayant récupéré le PDF au moins une fois
 *   - Téléchargements  : total des récupérations du PDF (download_count cumulé,
 *                        inclut le bouton immédiat, le lien courriel et les
 *                        re-téléchargements)
 *   - Opt-in courriel  : leads ayant coché le consentement marketing
 *   ... le tout ventilé FR / EN.
 *
 * Les données existent déjà : chaque lead porte son `source_form` (= la clé de
 * l'ebook) et son `download_count`. On agrège ici, aucune table dédiée requise.
 *
 * Sécurité : accès réservé via une clé secrète passée en query (?key=...),
 * comparée à EBOOK_STATS_KEY. Page non indexée.
 *
 * Variables d'environnement requises :
 *   - SUPABASE_URL                  (texte)
 *   - SUPABASE_SERVICE_ROLE_KEY     (secret)
 *   - EBOOK_STATS_KEY               (secret)  — clé d'accès au tableau de bord
 */

// Doit rester aligné avec ebook-request.js / download.js pour l'affichage des titres.
const LEAD_MAGNET_TITLES = {
    'ebook_anti_surprise':          'Le système anti-surprise',
    'ebook_vendre_sans_travestir':  'Vendre sans te travestir',
    'ebook_imprevu_sante':          "Préparer l'imprévu de santé"
};

export async function onRequestGet(context) {
    const { request, env } = context;

    try {
        const url = new URL(request.url);
        const key = url.searchParams.get('key') || '';

        // ── Vérification de la configuration ──────────────────────────
        if (!env.EBOOK_STATS_KEY) {
            return simplePage(
                'Tableau de bord non configuré',
                "La variable d'environnement EBOOK_STATS_KEY n'est pas encore définie dans Cloudflare Pages. " +
                "Ajoute-la (Settings → Environment variables), redéploie, puis reviens avec ?key=…",
                503
            );
        }
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
            return simplePage('Erreur de configuration', "Configuration Supabase manquante.", 500);
        }

        // ── Authentification ──────────────────────────────────────────
        if (!key || !constantTimeEqual(key, env.EBOOK_STATS_KEY)) {
            return simplePage('Accès refusé', "Clé d'accès manquante ou invalide.", 403);
        }

        // ── Récupération des leads (pagination par tranches de 1000) ──
        const supabaseHeaders = {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        };

        const rows = [];
        const PAGE = 1000;
        let offset = 0;
        while (true) {
            const res = await fetch(
                `${env.SUPABASE_URL}/rest/v1/marketing_leads` +
                `?select=source_form,lang,download_count,consent_marketing`,
                {
                    headers: Object.assign({}, supabaseHeaders, {
                        'Range-Unit': 'items',
                        'Range': `${offset}-${offset + PAGE - 1}`
                    })
                }
            );
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                console.error('Supabase fetch failed:', res.status, body);
                return simplePage('Erreur', "Impossible de lire les données pour le moment.", 502);
            }
            const batch = await res.json();
            if (!Array.isArray(batch) || batch.length === 0) break;
            rows.push(...batch);
            if (batch.length < PAGE) break;
            offset += PAGE;
            if (offset > 200000) break; // garde-fou
        }

        // ── Agrégation par ebook ──────────────────────────────────────
        const agg = {};
        const blank = () => ({
            requests: 0, downloaders: 0, downloads: 0, optin: 0,
            fr: { requests: 0, downloads: 0 },
            en: { requests: 0, downloads: 0 }
        });

        let totals = blank();
        for (const r of rows) {
            const key = r.source_form || 'inconnu';
            if (!agg[key]) agg[key] = blank();
            const a = agg[key];
            const dl = Number(r.download_count) || 0;
            const lang = r.lang === 'en' ? 'en' : 'fr';

            a.requests += 1;               totals.requests += 1;
            a.downloads += dl;             totals.downloads += dl;
            if (dl > 0) { a.downloaders += 1; totals.downloaders += 1; }
            if (r.consent_marketing) { a.optin += 1; totals.optin += 1; }
            a[lang].requests += 1;         totals[lang].requests += 1;
            a[lang].downloads += dl;       totals[lang].downloads += dl;
        }

        // Ordre : ebooks connus d'abord (dans l'ordre de la table), puis le reste.
        const knownOrder = Object.keys(LEAD_MAGNET_TITLES);
        const keys = Object.keys(agg).sort((x, y) => {
            const ix = knownOrder.indexOf(x), iy = knownOrder.indexOf(y);
            if (ix === -1 && iy === -1) return x.localeCompare(y);
            if (ix === -1) return 1;
            if (iy === -1) return -1;
            return ix - iy;
        });

        return dashboardPage(keys, agg, totals, rows.length);

    } catch (err) {
        console.error('Unexpected error in ebook-stats:', err);
        return simplePage('Erreur', "Une erreur inattendue est survenue.", 500);
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Rendu du tableau de bord
// ──────────────────────────────────────────────────────────────────────────

function dashboardPage(keys, agg, totals, nbRows) {
    const rowsHtml = keys.map(k => {
        const a = agg[k];
        const title = LEAD_MAGNET_TITLES[k] || k;
        const convPct = a.requests > 0 ? Math.round((a.downloaders / a.requests) * 100) : 0;
        return `
      <tr>
        <td class="name"><span class="dot"></span>${escapeHtml(title)}<div class="slug">${escapeHtml(k)}</div></td>
        <td class="num">${a.requests}</td>
        <td class="num">${a.downloaders}</td>
        <td class="num strong">${a.downloads}</td>
        <td class="num">${convPct}<span class="pct">%</span></td>
        <td class="num split">${a.fr.downloads}<span class="sub"> / ${a.fr.requests}</span></td>
        <td class="num split">${a.en.downloads}<span class="sub"> / ${a.en.requests}</span></td>
        <td class="num">${a.optin}</td>
      </tr>`;
    }).join('');

    const totalConv = totals.requests > 0 ? Math.round((totals.downloaders / totals.requests) * 100) : 0;

    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Téléchargements des guides — Vector</title>
<link href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0e1220; color: #e8ebf2; min-height: 100vh; padding: 2.5rem 1.25rem 4rem;
    line-height: 1.5;
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  .top { border-top: 4px solid #8BFF3C; padding-top: 1.6rem; margin-bottom: 2rem; }
  h1 { font-family: 'Red Hat Display', sans-serif; font-weight: 800; font-size: 1.9rem;
       letter-spacing: -0.5px; color: #F5F4EF; }
  .meta { color: #8a92a8; font-size: 0.85rem; margin-top: 0.35rem; }

  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.9rem; margin-bottom: 1.8rem; }
  .card { background: #151b2b; border: 1px solid #232b40; border-radius: 14px; padding: 1.2rem 1.3rem; }
  .card .k { color: #8a92a8; font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
  .card .v { font-family: 'Red Hat Display', sans-serif; font-weight: 800; font-size: 2.1rem; color: #F5F4EF; margin-top: 0.2rem; }
  .card .v.lime { color: #8BFF3C; }

  .table-wrap { overflow-x: auto; border: 1px solid #232b40; border-radius: 14px; background: #131826; }
  table { width: 100%; border-collapse: collapse; min-width: 760px; }
  thead th { text-align: right; font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; color: #8a92a8; padding: 0.9rem 0.8rem; border-bottom: 1px solid #232b40;
    white-space: nowrap; }
  thead th:first-child { text-align: left; }
  tbody td { padding: 0.95rem 0.8rem; border-bottom: 1px solid #1c2334; font-size: 0.95rem; }
  tbody tr:last-child td { border-bottom: none; }
  td.name { font-weight: 600; color: #F5F4EF; text-align: left; }
  td.name .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #8BFF3C; margin-right: 8px; }
  td.name .slug { color: #6b7290; font-size: 0.74rem; font-weight: 400; margin-top: 0.15rem; margin-left: 16px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; color: #c7cede; }
  td.num.strong { color: #8BFF3C; font-weight: 700; }
  td.num .pct, td.num .sub { color: #6b7290; font-size: 0.82em; }
  tfoot td { padding: 0.95rem 0.8rem; font-weight: 700; color: #F5F4EF; border-top: 2px solid #232b40; text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td:first-child { text-align: left; }

  .legend { color: #8a92a8; font-size: 0.82rem; margin-top: 1.3rem; line-height: 1.6; }
  .legend strong { color: #c7cede; font-weight: 600; }
  @media (max-width: 640px) {
    .cards { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1>Téléchargements des guides</h1>
      <div class="meta">Données en direct depuis Supabase · ${nbRows} lead${nbRows > 1 ? 's' : ''} au total</div>
    </div>

    <div class="cards">
      <div class="card"><div class="k">Demandes</div><div class="v">${totals.requests}</div></div>
      <div class="card"><div class="k">Téléchargements</div><div class="v lime">${totals.downloads}</div></div>
      <div class="card"><div class="k">Taux de téléchargement</div><div class="v">${totalConv}<span style="font-size:1.2rem;color:#6b7290">%</span></div></div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Guide</th>
            <th>Demandes</th>
            <th>Ont téléch.</th>
            <th>Téléch.</th>
            <th>Taux</th>
            <th>FR (tél./dem.)</th>
            <th>EN (tél./dem.)</th>
            <th>Opt-in</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="8" style="text-align:center;color:#6b7290;padding:2rem">Aucune donnée pour le moment.</td></tr>'}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td>${totals.requests}</td>
            <td>${totals.downloaders}</td>
            <td style="color:#8BFF3C">${totals.downloads}</td>
            <td>${totalConv}%</td>
            <td>${totals.fr.downloads} / ${totals.fr.requests}</td>
            <td>${totals.en.downloads} / ${totals.en.requests}</td>
            <td>${totals.optin}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <p class="legend">
      <strong>Demandes</strong> : formulaires soumis (un par courriel et par guide).
      <strong>Ont téléchargé</strong> : personnes ayant récupéré le PDF au moins une fois.
      <strong>Téléchargements</strong> : total des récupérations du PDF, incluant le bouton immédiat,
      le lien courriel et les re-téléchargements (donc supérieur ou égal au nombre de personnes).
      <strong>Opt-in</strong> : ont accepté de recevoir les courriels marketing.
    </p>
  </div>
</body>
</html>`;

    return new Response(html, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow'
        }
    });
}


// ──────────────────────────────────────────────────────────────────────────
// Page simple (erreurs / états)
// ──────────────────────────────────────────────────────────────────────────

function simplePage(title, body, status) {
    const html = `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)} — Vector</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0e1220; color: #e8ebf2; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 2rem; margin: 0; }
  .card { max-width: 480px; background: #151b2b; border: 1px solid #232b40; border-radius: 14px;
    padding: 2.2rem 2rem; border-top: 4px solid #8BFF3C; }
  h1 { font-size: 1.4rem; margin: 0 0 0.8rem; color: #F5F4EF; }
  p { color: #a7aec2; margin: 0; line-height: 1.6; }
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></div></body></html>`;
    return new Response(html, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow'
        }
    });
}


// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}
