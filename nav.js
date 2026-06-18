/**
 * nav.js — IDD Hub cross-app navigation
 *
 * Drop <link rel="stylesheet" href="/nav.css"> and
 *     <script src="/nav.js" defer></script> into any IDD/ACC page.
 * Injects a hub section into the existing .sidebar just above
 * .sidebar-footer (ACC) or .live-bar (IDD), linking to all built UCs.
 *
 * URL derivation (no config needed):
 *   localhost:3001  ↔  localhost:3002
 *   idd.domain.com  ↔  domain.com
 */
(function () {
  var h = location.hostname, port = location.port, proto = location.protocol;

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
      + ' stroke="currentColor" stroke-width="2" class="hub-icon">'
      + svg + '</svg>';
  }

  function row(uc, isActive) {
    var badge = '<span class="hub-badge">' + uc.sub + '</span>';
    if (isActive || !uc.url) {
      return '<div class="hub-row hub-active">'
        + icon(uc.svg) + '<span>' + uc.label + '</span>' + badge + '</div>';
    }
    return '<a href="' + uc.url + '" class="hub-row">'
      + icon(uc.svg) + '<span>' + uc.label + '</span>' + badge + '</a>';
  }

  function mount() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    var activeLabel = onIDD ? 'Digital Production' : 'Command Centre';

    var html = '<div class="hub-heading">IDD Hub</div>';
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
