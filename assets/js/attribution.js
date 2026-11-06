/**
 * Traffic-source capture (Google Ads / Meta / organic / AI / referral).
 * On every landing that carries a click ID, UTM tags or an external referrer,
 * records where the visitor came from; keeps the FIRST and LAST such visit for
 * 90 days in localStorage. checkout/contact/designer send it with the order or
 * lead, and api/_attribution.js prints the source in the notification email.
 * Loaded in <head> of every page.
 */
(function(){
  var KEY = 'aspagil-attribution';
  var MAX_AGE = 90 * 24 * 60 * 60 * 1000;
  var OWN = ["aspagil.com","gilcups.com","gintz.co.il","sumit.co.il","myofficeguy.com"];
  var PARAMS = ['gclid','gbraid','wbraid','fbclid','msclkid','ttclid','utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_id'];
  function host(u){ try { return new URL(u).hostname.replace(/^www\./,'').toLowerCase(); } catch(e){ return ''; } }
  function isOwn(h){ if(!h) return false; for (var i=0;i<OWN.length;i++){ if (h===OWN[i] || h.slice(-(OWN[i].length+1))==='.'+OWN[i]) return true; } return false; }
  try {
    var q = new URLSearchParams(window.location.search), t = {}, has = false;
    for (var i=0;i<PARAMS.length;i++){ var v = q.get(PARAMS[i]); if (v){ t[PARAMS[i]] = v.slice(0,300); has = true; } }
    var ref = document.referrer || '';
    var rh = host(ref);
    if (ref && rh !== window.location.hostname.replace(/^www\./,'') && !isOwn(rh)) { t.referrer = ref.slice(0,300); has = true; }
    if (has) {
      t.landing = (window.location.pathname + window.location.search).slice(0,300);
      t.ts = Date.now();
      var s = {}; try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch(e) { s = {}; }
      if (!s.first || !s.first.ts || Date.now() - s.first.ts > MAX_AGE) s.first = t;
      s.last = t;
      localStorage.setItem(KEY, JSON.stringify(s));
    }
  } catch(e) {}
  window.getAttribution = function(){
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!s || !s.last || Date.now() - s.last.ts > MAX_AGE) return undefined;
      return s;
    } catch(e) { return undefined; }
  };
})();
