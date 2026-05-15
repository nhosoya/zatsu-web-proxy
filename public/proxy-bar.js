(function () {
  var KEY = 'zatsu-proxy-history';
  var MAX_SAVE = 50;
  var MAX_SHOW = 8;

  function norm(v) {
    var t = (v || '').trim();
    if (!t) return '';
    var c = t.slice(0, 2) === '//' ? 'https:' + t
          : (/^[a-z][a-z0-9+.\-]*:/i.test(t) ? t : 'https://' + t);
    try {
      var u = new URL(c);
      return u.protocol === 'https:' ? u.toString() : '';
    } catch (e) { return ''; }
  }

  function loadHistory() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { raw = []; }
    var seen = Object.create(null), clean = [];
    for (var i = 0; i < raw.length; i++) {
      var n = norm(raw[i]);
      if (n && !seen[n]) { seen[n] = 1; clean.push(n); }
    }
    localStorage.setItem(KEY, JSON.stringify(clean));
    return clean;
  }

  function saveUrl(u) {
    var n = norm(u);
    if (!n) return;
    var h = loadHistory();
    h = [n].concat(h.filter(function (x) { return x !== n; })).slice(0, MAX_SAVE);
    localStorage.setItem(KEY, JSON.stringify(h));
  }

  function setup(input, opts) {
    opts = opts || {};
    if (opts.currentUrl) saveUrl(opts.currentUrl);

    // Wrap input so the dropdown can position-anchor to its bounding box.
    var wrap = document.createElement('div');
    wrap.className = 'zatsu-ac-wrap';
    var parent = input.parentNode;
    parent.insertBefore(wrap, input);
    wrap.appendChild(input);

    var dropdown = document.createElement('ul');
    dropdown.className = 'zatsu-ac-dropdown';
    dropdown.setAttribute('role', 'listbox');
    dropdown.style.display = 'none';
    wrap.appendChild(dropdown);

    var history = loadHistory();
    var matches = [];
    var activeIdx = -1;

    function render(filter) {
      var f = (filter || '').toLowerCase();
      matches = history.filter(function (u) {
        return !f || u.toLowerCase().indexOf(f) !== -1;
      }).slice(0, MAX_SHOW);
      dropdown.innerHTML = '';
      for (var i = 0; i < matches.length; i++) {
        var li = document.createElement('li');
        li.className = 'zatsu-ac-item';
        li.textContent = matches[i];
        li.setAttribute('role', 'option');
        // mousedown (not click) so it fires before the input's blur.
        li.addEventListener('mousedown', (function (val) {
          return function (e) {
            e.preventDefault();
            pickValue(val);
          };
        })(matches[i]));
        dropdown.appendChild(li);
      }
      dropdown.style.display = matches.length ? 'block' : 'none';
      activeIdx = -1;
    }

    // Fill the input without submitting so the user can still tweak the URL
    // (add a query string, fix a typo, etc.) before pressing Enter / Go.
    function pickValue(val) {
      input.value = val;
      input.focus();
      // Put the caret at the end so further typing appends naturally.
      try {
        var len = val.length;
        input.setSelectionRange(len, len);
      } catch (e) { /* not all input types support setSelectionRange */ }
      dropdown.style.display = 'none';
      activeIdx = -1;
    }

    function updateActive() {
      var items = dropdown.children;
      for (var i = 0; i < items.length; i++) {
        if (i === activeIdx) {
          items[i].classList.add('active');
          // Keep highlighted item visible.
          var top = items[i].offsetTop;
          var bottom = top + items[i].offsetHeight;
          if (top < dropdown.scrollTop) dropdown.scrollTop = top;
          else if (bottom > dropdown.scrollTop + dropdown.clientHeight) {
            dropdown.scrollTop = bottom - dropdown.clientHeight;
          }
        } else {
          items[i].classList.remove('active');
        }
      }
    }

    input.addEventListener('focus', function () {
      history = loadHistory();
      render(input.value);
    });
    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('blur', function () {
      // Delay so a click on a dropdown item is processed first.
      setTimeout(function () { dropdown.style.display = 'none'; }, 150);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!matches.length) return;
        activeIdx = (activeIdx + 1) % matches.length;
        updateActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!matches.length) return;
        activeIdx = activeIdx <= 0 ? matches.length - 1 : activeIdx - 1;
        updateActive();
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        // Enter on an active suggestion just fills the input — the user
        // still needs a second Enter (or click Go) to actually submit, so
        // they can add a path / query before navigating.
        e.preventDefault();
        pickValue(matches[activeIdx]);
      } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
        activeIdx = -1;
      }
    });

    if (input.form) {
      input.form.addEventListener('submit', function () {
        saveUrl(input.value);
      });
    }
  }

  function autoInit() {
    var inputs = document.querySelectorAll('[data-zatsu-ac]');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.__zatsuAcReady) continue;
      el.__zatsuAcReady = true;
      setup(el, { currentUrl: el.getAttribute('data-zatsu-current-url') || '' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})();
