/* ============================================================
   VECTOR — analytics.js · tracking + funnel ebook + partage social
   Statique, multi-pages, sans framework. Chargé via <script src="/analytics.js">.
   La page déclare AVANT ce script :
     window.VECTOR_PAGE    = { page_type, page_slug, lang }      // pour la vue de page
     window.VECTOR_ARTICLE = { slug, url, title, excerpt, lang } // pour ebook + partage
   Projet Supabase vector-website ; clé anon publique (RLS en écriture seule).
   ============================================================ */
(function () {
  "use strict";
  var ANALYTICS_URL = 'https://zywdoslrrlnxhpoyauyp.supabase.co';
  var ANALYTICS_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5d2Rvc2xycmxueGhwb3lhdXlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0NDU1NjcsImV4cCI6MjA5NDAyMTU2N30.9PNTLQac7Z13k9mGVeqIqQFcYA_OwLOmpKYtNCq8WSU';
  var ENGAGE_MS = 30000;

  function noTrack() { try { return !!localStorage.getItem('vector_no_track'); } catch (e) { return false; } }
  function lang() { return (window.VECTOR_PAGE && window.VECTOR_PAGE.lang) || (window.VECTOR_ARTICLE && window.VECTOR_ARTICLE.lang) || 'fr'; }
  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  /* ── Attribution UTM (premier-touch, cookieless, conforme Loi 25) ── */
  function cleanReferer() {
    try {
      var r = document.referrer; if (!r) return null;
      var u = new URL(r); if (u.host === location.host) return null;
      return (u.host + u.pathname).slice(0, 300);
    } catch (e) { return null; }
  }
  function getAttribution() {
    var KEY = 'vector_attribution', stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) {}
    var p = new URLSearchParams(location.search);
    var cur = {
      utm_source: p.get('utm_source'), utm_medium: p.get('utm_medium'),
      utm_campaign: p.get('utm_campaign'), utm_term: p.get('utm_term'), utm_content: p.get('utm_content')
    };
    var hasUtm = Object.keys(cur).some(function (k) { return cur[k]; });
    if (!stored && hasUtm) {
      stored = Object.assign({}, cur, { referer_url: cleanReferer(), captured_at: new Date().toISOString() });
      try { sessionStorage.setItem(KEY, JSON.stringify(stored)); } catch (e) {}
    }
    var a = stored || cur;
    return {
      utm_source: a.utm_source || null, utm_medium: a.utm_medium || null,
      utm_campaign: a.utm_campaign || null, utm_term: a.utm_term || null, utm_content: a.utm_content || null,
      referer_url: (a.referer_url != null ? a.referer_url : cleanReferer())
    };
  }

  /* ── Vue de page qualifiée (≥30 s d'engagement actif ; pause en arrière-plan) ── */
  var timer = null, remaining = ENGAGE_MS, startedAt = 0, pending = null;
  function resume() {
    if (!pending || timer || document.visibilityState !== 'visible') return;
    startedAt = Date.now();
    timer = setTimeout(function () {
      var payload = pending; pending = null; timer = null; remaining = ENGAGE_MS;
      insertPageView(payload);
    }, remaining);
  }
  function pause() {
    if (!timer) return;
    clearTimeout(timer); timer = null;
    remaining -= (Date.now() - startedAt); if (remaining < 0) remaining = 0;
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') resume(); else pause();
  });
  function insertPageView(payload) {
    try {
      var attr = getAttribution();
      fetch(ANALYTICS_URL + '/rest/v1/page_view_events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANALYTICS_KEY, 'Authorization': 'Bearer ' + ANALYTICS_KEY, 'Prefer': 'return=minimal' },
        body: JSON.stringify(Object.assign({
          page_type: payload.page_type, page_slug: payload.page_slug || null,
          article_id: payload.article_id || null, lang: payload.lang || null
        }, attr))
      });
    } catch (e) {}
  }
  function trackPageView(opts) {
    if (noTrack()) return;
    if (timer) { clearTimeout(timer); timer = null; }
    remaining = ENGAGE_MS;
    pending = {
      page_type: opts.page_type, page_slug: opts.page_slug || null,
      article_id: opts.article_id || (opts.page_type === 'article' ? (opts.page_slug || null) : null),
      lang: opts.lang || lang()
    };
    resume();
  }

  function trackEvent(eventType, metadata, leadId, leadKind) {
    if (noTrack()) return;
    try {
      var attr = getAttribution();
      var slug = (window.VECTOR_ARTICLE && window.VECTOR_ARTICLE.slug) || (window.VECTOR_PAGE && window.VECTOR_PAGE.page_slug) || null;
      fetch(ANALYTICS_URL + '/rest/v1/marketing_events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANALYTICS_KEY, 'Authorization': 'Bearer ' + ANALYTICS_KEY, 'Prefer': 'return=minimal' },
        body: JSON.stringify(Object.assign({
          event_type: eventType, lead_id: leadId || null, lead_kind: leadKind || null,
          page_slug: slug, metadata: metadata || {}
        }, attr))
      });
    } catch (e) {}
  }

  /* ── Funnel ebook (formulaire dans le contenu de l'article) ── */
  async function requestEbook(event, lng) {
    event.preventDefault();
    var form = event.target;
    var button = form.querySelector('button[type="submit"]');
    var originalText = button.textContent;
    button.disabled = true;
    button.textContent = lng === 'fr' ? 'Envoi en cours…' : 'Sending…';
    var oldError = form.parentElement.querySelector('.ebook-form-error');
    if (oldError) oldError.remove();

    var sourceArticle = (window.VECTOR_ARTICLE && window.VECTOR_ARTICLE.slug) || null;
    var payload = Object.assign({
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      lang: lng,
      source_form: 'ebook_anti_surprise',
      consent_marketing: form.consent_marketing && form.consent_marketing.checked === true,
      source_article: sourceArticle,
      source_url: window.location.href
    }, getAttribution());

    try {
      var res = await fetch('/api/ebook-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Request failed: ' + res.status);
      var data = await res.json();
      var downloadUrl = data.download_url;
      var filename = data.filename || 'Vector-Guide.pdf';
      var firstName = (form.name.value.trim().split(/\s+/)[0]) || (lng === 'fr' ? 'là' : 'there');
      var headingText = (lng === 'fr' ? 'Parfait, ' : 'Perfect, ') + escapeHtml(firstName) + '.';
      var subheadText = lng === 'fr' ? '« Le système anti-surprise » est prêt.' : '"The anti-surprise system" is ready.';
      var buttonText = lng === 'fr' ? '📄 Télécharger le guide maintenant' : '📄 Download the guide now';
      var emailNote = lng === 'fr' ? 'Une copie est aussi en route vers ta boîte courriel.' : 'A copy is also on its way to your inbox.';
      var teaserText = lng === 'fr'
        ? 'Ouvre-le maintenant. Si tu le lis avant dimanche, tu peux appliquer le système dès cette semaine. Lundi prochain ne sera pas comme les autres.'
        : "Open it now. If you read it before Sunday, you can apply the system this week. Next Monday won't be like the others.";
      var successHTML =
        '<div class="ebook-form-success">' +
          '<svg class="ebook-success-check" width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<circle cx="24" cy="24" r="22" fill="rgba(139,255,60,0.12)" stroke="#8BFF3C" stroke-width="2"/>' +
            '<path d="M14 24l7 7 13-14" stroke="#8BFF3C" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
          '</svg>' +
          '<p class="ebook-success-heading">' + headingText + '</p>' +
          '<p class="ebook-success-subhead">' + subheadText + '</p>' +
          '<p class="ebook-success-cta"><a href="' + downloadUrl + '" download="' + filename + '" class="ebook-download-btn" target="_blank" rel="noopener">' + buttonText + '</a></p>' +
          '<p class="ebook-success-email-note">' + emailNote + '</p>' +
          '<div class="ebook-success-divider"></div>' +
          '<p class="ebook-success-teaser">' + teaserText + '</p>' +
        '</div>';
      var ctaCard = form.closest('.ebook-cta') || form.parentElement;
      ctaCard.innerHTML = successHTML;
      trackEvent('download_started', { source_form: 'ebook_anti_surprise', article: sourceArticle || null });
    } catch (err) {
      button.disabled = false; button.textContent = originalText;
      var errMsg = lng === 'fr'
        ? 'Une erreur est survenue. Réessaie dans un moment, ou écris à support@vectorplanning.ai.'
        : 'Something went wrong. Please try again, or email support@vectorplanning.ai.';
      var errEl = document.createElement('p');
      errEl.className = 'ebook-form-error'; errEl.textContent = errMsg;
      form.insertAdjacentElement('afterend', errEl);
    }
    return false;
  }

  /* ── Partage social (URL canonique de l'article) ── */
  function showToast(msg) {
    var el = document.getElementById('share-toast');
    if (!el) { el = document.createElement('div'); el.id = 'share-toast'; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('show');
    clearTimeout(el._t); el._t = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }
  function shareArticle(platform) {
    var art = window.VECTOR_ARTICLE || {};
    var url = art.url || location.href;
    var title = art.title || document.title;
    var fr = lang() === 'fr';
    switch (platform) {
      case 'facebook':
        window.open('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url), '_blank', 'width=620,height=450,noopener'); break;
      case 'x':
        window.open('https://twitter.com/intent/tweet?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(title), '_blank', 'width=620,height=450,noopener'); break;
      case 'linkedin':
        window.open('https://www.linkedin.com/sharing/share-offsite/?url=' + encodeURIComponent(url), '_blank', 'width=620,height=520,noopener'); break;
      case 'copy':
        navigator.clipboard.writeText(url).then(function () { showToast(fr ? 'Lien copié !' : 'Link copied!'); }); break;
      case 'instagram':
        navigator.clipboard.writeText(url).then(function () { showToast(fr ? 'Lien copié — colle-le dans ta story.' : 'Link copied — paste it in your story.'); }); break;
    }
  }

  // Exposition globale (handlers inline du contenu : onsubmit/onclick)
  window.getAttribution = getAttribution;
  window.trackPageView = trackPageView;
  window.trackEvent = trackEvent;
  window.requestEbook = requestEbook;
  window.shareArticle = shareArticle;
  window.showToast = showToast;

  // Vue de page initiale (déclarée par window.VECTOR_PAGE)
  function auto() { if (window.VECTOR_PAGE) trackPageView(window.VECTOR_PAGE); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto); else auto();
})();
