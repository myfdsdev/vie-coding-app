import type { Plugin } from 'vite';

/**
 * Injects the error-capture shim into every preview document.
 *
 * Everything the agent needs to debug is forwarded to the parent frame as a
 * structured postMessage. Without this, a crashed preview is a blank white
 * page and the agent has nothing to work with.
 */
export function previewInstrumentation(): Plugin {
  return {
    name: 'preview-instrumentation',
    apply: 'serve',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module' },
          injectTo: 'head-prepend',
          children: SHIM,
        },
      ];
    },
  };
}

const SHIM = /* js */ `
(function () {
  var send = function (p) {
    try { parent.postMessage(Object.assign({ __preview_event: true, ts: Date.now() }, p), '*'); } catch (e) {}
  };

  window.addEventListener('error', function (e) {
    send({ type: 'UNCAUGHT_EXCEPTION', message: e.message, stack: e.error && e.error.stack,
           file: e.filename, line: e.lineno, col: e.colno, pathname: location.pathname });
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason || {};
    send({ type: 'UNHANDLED_REJECTION', message: String(r.message || r), stack: r.stack });
  });

  var _error = console.error;
  console.error = function () {
    var args = Array.prototype.slice.call(arguments);
    send({ type: 'CONSOLE_ERROR', args: args.map(String), stack: new Error().stack });
    return _error.apply(console, args);
  };

  var _fetch = window.fetch;
  window.fetch = function () {
    var args = Array.prototype.slice.call(arguments);
    return _fetch.apply(window, args).then(function (res) {
      if (!res.ok) {
        res.clone().text().catch(function () { return ''; }).then(function (body) {
          send({ type: 'NETWORK_ERROR', status: res.status, url: String(args[0]),
                 method: (args[1] && args[1].method) || 'GET', body: String(body).slice(0, 2000) });
        });
      }
      return res;
    }, function (err) {
      send({ type: 'NETWORK_FAILURE', url: String(args[0]), message: String(err) });
      throw err;
    });
  };

  if (import.meta && import.meta.hot) {
    import.meta.hot.on('vite:error', function (p) {
      var err = (p && p.err) || {};
      send({ type: 'BUILD_ERROR', message: err.message, stack: err.stack, frame: err.frame, id: err.id });
    });
  }

  // Blank-screen detector: nothing threw, but nothing rendered either.
  setTimeout(function () {
    var root = document.getElementById('root');
    if (!root || root.childElementCount === 0) send({ type: 'BLANK_SCREEN', pathname: location.pathname });
    else send({ type: 'RENDER_OK', pathname: location.pathname });
  }, 2500);
})();
`;
