/**
 * nav.js — IDD Hub cross-app navigation
 *
 * Drop <script src="/nav.js" defer></script> into any IDD/ACC page.
 * Injects a hub section into the existing .sidebar just above
 * .sidebar-footer (ACC) or .live-bar (IDD), linking to all built UCs.
 *
 * URL derivation (no config needed):
 *   localhost:3001  ↔  localhost:3002
 *   idd.domain.com  ↔  domain.com
 */
(function () {
  var h = location.hostname, port = location.port, proto = location.protocol;

  // Determine which app we're on and the peer's base URL
  var onIDD  = port === '3002' || h.startsWith('idd.');
  var accUrl = onIDD
    ? (port ? proto + '//localhost:3001' : proto + '//' + h.replace(/^idd\./, ''))
    : null;
  var iddUrl = onIDD
    ? null
    : (port ? proto + '//localhost:3002' : proto + '//idd.' + h);

  var UCS = [
    {
      label: 'Command Centre',
      sub:   'UC 3–6 · Dashboard',
      url:   accUrl,
      svg:   '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    },
    {
      label: 'Digital Production',
      sub:   'UC 3 · Live',
      url:   iddUrl,
      svg:   '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
    },
    {
      label: 'Digital Logistics',
      sub:   'UC 4 · Mock',
      url:   accUrl ? accUrl + '#idd-logistics' : null,
      svg:   '<rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    },
    {
      label: 'QSE Inspection',
      sub:   'UC 6 · Mock',
      url:   accUrl ? accUrl + '#qse' : null,
      svg:   '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    },
  ];

  function icon(svg) {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"'
      + ' stroke="currentColor" stroke-width="2" style="flex-shrink:0">'
      + svg + '</svg>';
  }

  function row(uc, isActive) {
    var style = 'display:flex;align-items:center;gap:8px;padding:6px 10px;'
      + 'font-size:11px;border-radius:5px;margin:1px 4px;transition:background .12s;'
      + (isActive
          ? 'color:#6ee7b7;background:rgba(13,148,136,.25);cursor:default;'
          : 'color:rgba(255,255,255,.65);text-decoration:none;cursor:pointer;');
    var badge = '<span style="margin-left:auto;font-size:8px;padding:1px 4px;'
      + 'border-radius:3px;background:rgba(13,148,136,.35);color:#6ee7b7;white-space:nowrap;">'
      + uc.sub + '</span>';
    if (isActive || !uc.url) {
      return '<div style="' + style + '">' + icon(uc.svg) + '<span>' + uc.label + '</span>' + badge + '</div>';
    }
    return '<a href="' + uc.url + '" style="' + style + '"'
      + ' onmouseover="this.style.background=\'rgba(255,255,255,.07)\'"'
      + ' onmouseout="this.style.background=\'\'">'
      + icon(uc.svg) + '<span>' + uc.label + '</span>' + badge + '</a>';
  }

  function mount() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    // Determine which row is the current page
    var activeLabel = onIDD ? 'Digital Production' : 'Command Centre';
    // If we're on the acc page but on the logistics section, highlight logistics —
    // but that's runtime state; keep it simple and just highlight the app.

    var html = '<div style="'
      + 'padding:6px 10px 4px;font-size:9px;font-weight:700;letter-spacing:.07em;'
      + 'color:rgba(255,255,255,.35);text-transform:uppercase;margin-top:6px;'
      + 'border-top:1px solid rgba(255,255,255,.08);">'
      + 'IDD Hub</div>';

    UCS.forEach(function (uc) {
      html += row(uc, uc.label === activeLabel);
    });

    var section = document.createElement('div');
    section.id  = 'idd-hub-nav';
    section.innerHTML = html;

    var anchor = sidebar.querySelector('.sidebar-footer, .live-bar');
    if (anchor) sidebar.insertBefore(section, anchor);
    else        sidebar.appendChild(section);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
}());
