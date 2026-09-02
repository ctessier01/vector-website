/**
 * Cloudflare Pages Function — GET /api/ebook-stats?key=...
 *
 * Tableau de bord interne des lead magnets. Affiche, par ebook :
 *   - Demandes         : formulaires soumis (lignes marketing_leads)
 *   - Ont téléchargé   : personnes ayant récupéré le PDF au moins une fois
 *   - Téléchargements  : récupérations réelles du PDF
 *   - Opt-in courriel  : leads ayant coché le consentement marketing
 *   ... ventilé FR / EN, et filtrable par date.
 *
 * FILTRAGE PAR DATE
 *   - Demandes : filtrées sur marketing_leads.created_at (historique complet).
 *   - Téléchargements : deux sources selon la vue :
 *       • Vue « Tout »  → compteur cumulé marketing_leads.download_count
 *                         (total historique fiable, depuis toujours).
 *       • Vue par période → journal daté dans marketing_events
 *                         (event_type='download_started', metadata.kind='file_fetch'),
 *                         écrit par /api/download depuis le LOG_START ci-dessous.
 *     Les téléchargements datés d'AVANT le LOG_START ne sont pas dans le journal :
 *     une note le rappelle sur les vues par période.
 *
 * Query :
 *   key         (obligatoire)  — comparé à EBOOK_STATS_KEY
 *   range       24h|7d|30d|90d|1y|all   (défaut : all)
 *   from, to    AAAA-MM-JJ     — plage personnalisée (prioritaire sur range)
 *
 * Variables d'environnement :
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EBOOK_STATS_KEY
 */

const LEAD_MAGNET_TITLES = {
    'ebook_anti_surprise':          'Le système anti-surprise',
    'ebook_vendre_sans_travestir':  'Vendre sans te travestir',
    'ebook_imprevu_sante':          "Préparer l'imprévu de santé"
};

// Date de mise en place du journal daté des téléchargements (voir /api/download).
const LOG_START = '2026-09-02';

const RANGES = [
    { key: '24h', label: '24 h',    days: 1 },
    { key: '7d',  label: '7 jours', days: 7 },
    { key: '30d', label: '30 jours', days: 30 },
    { key: '90d', label: '90 jours', days: 90 },
    { key: '1y',  label: '1 an',    days: 365 },
    { key: 'all', label: 'Tout',    days: null }
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestGet(context) {
    const { request, env } = context;

    try {
        const url = new URL(request.url);
        const key = url.searchParams.get('key') || '';

        if (!env.EBOOK_STATS_KEY) {
            return simplePage('Tableau de bord non configuré',
                "La variable d'environnement EBOOK_STATS_KEY n'est pas définie dans Cloudflare Pages. " +
                "Ajoute-la (Settings → Variables), redéploie, puis reviens avec ?key=…", 503);
        }
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
            return simplePage('Erreur de configuration', "Configuration Supabase manquante.", 500);
        }
        if (!key || !constantTimeEqual(key, env.EBOOK_STATS_KEY)) {
            return simplePage('Accès refusé', "Clé d'accès manquante ou invalide.", 403);
        }

        // ── Fenêtre de dates ──────────────────────────────────────────
        const fromRaw = (url.searchParams.get('from') || '').trim();
        const toRaw = (url.searchParams.get('to') || '').trim();
        let rangeKey = (url.searchParams.get('range') || 'all').trim();
        if (!RANGES.some(r => r.key === rangeKey)) rangeKey = 'all';

        let startIso = null, endIso = null, mode = 'all', activeRange = 'all';
        let customFrom = '', customTo = '';

        if ((fromRaw && DATE_RE.test(fromRaw)) || (toRaw && DATE_RE.test(toRaw))) {
            // Plage personnalisée
            mode = 'window';
            activeRange = 'custom';
            if (fromRaw && DATE_RE.test(fromRaw)) { startIso = `${fromRaw}T00:00:00.000Z`; customFrom = fromRaw; }
            if (toRaw && DATE_RE.test(toRaw))     { endIso   = `${toRaw}T23:59:59.999Z`;   customTo = toRaw; }
        } else if (rangeKey !== 'all') {
            const r = RANGES.find(x => x.key === rangeKey);
            mode = 'window';
            activeRange = rangeKey;
            startIso = new Date(Date.now() - r.days * 86400000).toISOString();
        }

        const supaHeaders = {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
        };

        // ── Demandes (marketing_leads, filtrées par created_at) ───────
        let leadFilter = '';
        if (startIso) leadFilter += `&created_at=gte.${encodeURIComponent(startIso)}`;
        if (endIso)   leadFilter += `&created_at=lte.${encodeURIComponent(endIso)}`;

        const leads = await fetchAll(env,
            `${env.SUPABASE_URL}/rest/v1/marketing_leads` +
            `?select=source_form,lang,download_count,consent_marketing,created_at${leadFilter}`,
            supaHeaders);
        if (leads === null) return simplePage('Erreur', "Impossible de lire les demandes.", 502);

        // ── Agrégation ────────────────────────────────────────────────
        const agg = {};
        const totals = blank();
        const dlSets = {}; // source_form -> Set(lead_id) pour les téléchargeurs uniques (mode période)

        const ensure = (k) => { if (!agg[k]) { agg[k] = blank(); dlSets[k] = new Set(); } return agg[k]; };

        for (const r of leads) {
            const k = r.source_form || 'inconnu';
            const a = ensure(k);
            const lang = r.lang === 'en' ? 'en' : 'fr';
            a.requests += 1;                 totals.requests += 1;
            a[lang].requests += 1;           totals[lang].requests += 1;
            if (r.consent_marketing) { a.optin += 1; totals.optin += 1; }

            if (mode === 'all') {
                const dl = Number(r.download_count) || 0;
                a.downloads += dl;           totals.downloads += dl;
                a[lang].downloads += dl;     totals[lang].downloads += dl;
                if (dl > 0) { a.downloaders += 1; totals.downloaders += 1; }
            }
        }

        let logNote = '';
        if (mode === 'window') {
            // Téléchargements datés depuis le journal d'événements
            let evFilter = `?event_type=eq.download_started&select=metadata,lead_id,created_at`;
            if (startIso) evFilter += `&created_at=gte.${encodeURIComponent(startIso)}`;
            if (endIso)   evFilter += `&created_at=lte.${encodeURIComponent(endIso)}`;

            const events = await fetchAll(env,
                `${env.SUPABASE_URL}/rest/v1/marketing_events${evFilter}`, supaHeaders);
            if (events === null) return simplePage('Erreur', "Impossible de lire le journal des téléchargements.", 502);

            for (const e of events) {
                const m = e.metadata || {};
                if (m.kind !== 'file_fetch') continue; // ignore l'événement client (soumission)
                const k = m.source_form || 'inconnu';
                const a = ensure(k);
                const lang = m.lang === 'en' ? 'en' : 'fr';
                a.downloads += 1;            totals.downloads += 1;
                a[lang].downloads += 1;      totals[lang].downloads += 1;
                if (e.lead_id) {
                    if (!dlSets[k].has(e.lead_id)) { a.downloaders += 1; totals.downloaders += 1; }
                    dlSets[k].add(e.lead_id);
                }
            }
            logNote = `Sur une période, les téléchargements proviennent du journal daté, en place depuis le ${LOG_START}. ` +
                      `Les téléchargements antérieurs ne sont comptés que dans la vue « Tout » (compteur cumulé).`;
        }

        const knownOrder = Object.keys(LEAD_MAGNET_TITLES);
        const keys = Object.keys(agg).sort((x, y) => {
            const ix = knownOrder.indexOf(x), iy = knownOrder.indexOf(y);
            if (ix === -1 && iy === -1) return x.localeCompare(y);
            if (ix === -1) return 1;
            if (iy === -1) return -1;
            return ix - iy;
        });

        return dashboardPage({
            keys, agg, totals, key,
            activeRange, customFrom, customTo, mode, logNote,
            nbLeads: leads.length
        });

    } catch (err) {
        console.error('Unexpected error in ebook-stats:', err);
        return simplePage('Erreur', "Une erreur inattendue est survenue.", 500);
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Données
// ──────────────────────────────────────────────────────────────────────────

function blank() {
    return {
        requests: 0, downloaders: 0, downloads: 0, optin: 0,
        fr: { requests: 0, downloads: 0 },
        en: { requests: 0, downloads: 0 }
    };
}

// Récupère toutes les lignes d'une ressource PostgREST par tranches de 1000.
// Retourne un tableau, ou null en cas d'erreur.
async function fetchAll(env, urlBase, headers) {
    const PAGE = 1000;
    let offset = 0;
    const out = [];
    while (true) {
        const res = await fetch(urlBase, {
            headers: Object.assign({}, headers, {
                'Range-Unit': 'items',
                'Range': `${offset}-${offset + PAGE - 1}`
            })
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error('Supabase fetch failed:', res.status, body);
            return null;
        }
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        out.push(...batch);
        if (batch.length < PAGE) break;
        offset += PAGE;
        if (offset > 500000) break; // garde-fou
    }
    return out;
}


// ──────────────────────────────────────────────────────────────────────────
// Rendu du tableau de bord
// ──────────────────────────────────────────────────────────────────────────

function dashboardPage({ keys, agg, totals, key, activeRange, customFrom, customTo, mode, logNote, nbLeads }) {
    const qk = encodeURIComponent(key);

    const presets = RANGES.map(r => {
        const active = activeRange === r.key ? ' active' : '';
        return `<a class="chip${active}" href="?key=${qk}&range=${r.key}">${r.label}</a>`;
    }).join('');

    const dlHeader = mode === 'all' ? 'Téléch. (cumul)' : 'Téléch. (période)';

    const rowsHtml = keys.map(k => {
        const a = agg[k];
        const title = LEAD_MAGNET_TITLES[k] || k;
        const conv = a.requests > 0 ? Math.round((a.downloaders / a.requests) * 100) : 0;
        return `
      <tr>
        <td class="name"><span class="dot"></span>${escapeHtml(title)}<div class="slug">${escapeHtml(k)}</div></td>
        <td class="num">${a.requests}</td>
        <td class="num">${a.downloaders}</td>
        <td class="num strong">${a.downloads}</td>
        <td class="num">${conv}<span class="pct">%</span></td>
        <td class="num split">${a.fr.downloads}<span class="sub"> / ${a.fr.requests}</span></td>
        <td class="num split">${a.en.downloads}<span class="sub"> / ${a.en.requests}</span></td>
        <td class="num">${a.optin}</td>
      </tr>`;
    }).join('');

    const totalConv = totals.requests > 0 ? Math.round((totals.downloaders / totals.requests) * 100) : 0;

    const rangeCaption =
        activeRange === 'all' ? 'Depuis toujours'
      : activeRange === 'custom' ? `Du ${customFrom || '…'} au ${customTo || "aujourd'hui"}`
      : (RANGES.find(r => r.key === activeRange) || {}).label
          ? `Derniers ${(RANGES.find(r => r.key === activeRange)).label}` : '';

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
    background: #0e1220; color: #e8ebf2; min-height: 100vh; padding: 2.5rem 1.25rem 4rem; line-height: 1.5;
  }
  .wrap { max-width: 1000px; margin: 0 auto; }
  .top { border-top: 4px solid #8BFF3C; padding-top: 1.6rem; margin-bottom: 1.6rem; }
  h1 { font-family: 'Red Hat Display', sans-serif; font-weight: 800; font-size: 1.9rem; letter-spacing: -0.5px; color: #F5F4EF; }
  .meta { color: #8a92a8; font-size: 0.85rem; margin-top: 0.35rem; }

  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 0.9rem; margin-bottom: 1.6rem; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .chip {
    display: inline-block; padding: 0.42rem 0.85rem; border-radius: 999px; text-decoration: none;
    font-size: 0.85rem; font-weight: 600; color: #c7cede; background: #151b2b; border: 1px solid #232b40;
  }
  .chip:hover { border-color: #39456a; }
  .chip.active { background: #8BFF3C; color: #0e1220; border-color: #8BFF3C; }
  .custom { display: flex; align-items: center; gap: 0.4rem; margin-left: auto; }
  .custom label { font-size: 0.8rem; color: #8a92a8; }
  .custom input[type=date] {
    background: #151b2b; border: 1px solid #232b40; color: #e8ebf2; border-radius: 8px;
    padding: 0.38rem 0.5rem; font-family: inherit; font-size: 0.85rem; color-scheme: dark;
  }
  .custom button {
    background: #232b40; color: #e8ebf2; border: 1px solid #39456a; border-radius: 8px;
    padding: 0.42rem 0.9rem; font-family: inherit; font-size: 0.85rem; font-weight: 600; cursor: pointer;
  }
  .custom button:hover { background: #2c3550; }

  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.9rem; margin-bottom: 1.5rem; }
  .card { background: #151b2b; border: 1px solid #232b40; border-radius: 14px; padding: 1.2rem 1.3rem; }
  .card .k { color: #8a92a8; font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
  .card .v { font-family: 'Red Hat Display', sans-serif; font-weight: 800; font-size: 2.1rem; color: #F5F4EF; margin-top: 0.2rem; }
  .card .v.lime { color: #8BFF3C; }
  .card .cap { color: #6b7290; font-size: 0.76rem; margin-top: 0.15rem; }

  .table-wrap { overflow-x: auto; border: 1px solid #232b40; border-radius: 14px; background: #131826; }
  table { width: 100%; border-collapse: collapse; min-width: 780px; }
  thead th { text-align: right; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    color: #8a92a8; padding: 0.9rem 0.8rem; border-bottom: 1px solid #232b40; white-space: nowrap; }
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
  .note { color: #b9a24a; font-size: 0.8rem; margin-top: 0.8rem; line-height: 1.5; }
  @media (max-width: 640px) { .cards { grid-template-columns: 1fr; } .custom { margin-left: 0; } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1>Téléchargements des guides</h1>
      <div class="meta">${escapeHtml(rangeCaption)} · ${nbLeads} demande${nbLeads > 1 ? 's' : ''} sur la période · données en direct</div>
    </div>

    <div class="controls">
      <div class="chips">${presets}</div>
      <form class="custom" method="get" action="/api/ebook-stats">
        <input type="hidden" name="key" value="${escapeHtml(key)}">
        <label>Du</label>
        <input type="date" name="from" value="${escapeHtml(customFrom)}">
        <label>au</label>
        <input type="date" name="to" value="${escapeHtml(customTo)}">
        <button type="submit">Filtrer</button>
      </form>
    </div>

    <div class="cards">
      <div class="card"><div class="k">Demandes</div><div class="v">${totals.requests}</div><div class="cap">${escapeHtml(rangeCaption)}</div></div>
      <div class="card"><div class="k">Téléchargements</div><div class="v lime">${totals.downloads}</div><div class="cap">${mode === 'all' ? 'Compteur cumulé' : 'Journal daté'}</div></div>
      <div class="card"><div class="k">Taux de téléchargement</div><div class="v">${totalConv}<span style="font-size:1.2rem;color:#6b7290">%</span></div><div class="cap">Ont téléchargé / demandes</div></div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Guide</th><th>Demandes</th><th>Ont téléch.</th><th>${dlHeader}</th>
            <th>Taux</th><th>FR (t/d)</th><th>EN (t/d)</th><th>Opt-in</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="8" style="text-align:center;color:#6b7290;padding:2rem">Aucune donnée pour cette période.</td></tr>'}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td><td>${totals.requests}</td><td>${totals.downloaders}</td>
            <td style="color:#8BFF3C">${totals.downloads}</td><td>${totalConv}%</td>
            <td>${totals.fr.downloads} / ${totals.fr.requests}</td>
            <td>${totals.en.downloads} / ${totals.en.requests}</td><td>${totals.optin}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    ${logNote ? `<p class="note">${escapeHtml(logNote)}</p>` : ''}

    <p class="legend">
      <strong>Demandes</strong> : formulaires soumis (un par courriel et par guide), filtrées par date de soumission.
      <strong>Ont téléchargé</strong> : personnes ayant récupéré le PDF au moins une fois.
      <strong>Téléchargements</strong> : récupérations réelles du PDF (bouton immédiat, lien courriel, re-téléchargements).
      <strong>FR (t/d)</strong> et <strong>EN (t/d)</strong> : téléchargements / demandes par langue.
      <strong>Opt-in</strong> : ont accepté les courriels marketing.
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
