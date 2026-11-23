// Tiny dependency-free router: register routes with Express-style ":param"
// segments, match a (method, pathname) pair, get back the handler + params.

class Router {
  constructor() {
    this.routes = []; // { method, regex, paramNames, handler }
  }

  _add(method, pattern, handler) {
    const paramNames = [];
    const regexStr = pattern
      .replace(/\/:([^/]+)/g, (_, name) => {
        paramNames.push(name);
        return "/([^/]+)";
      })
      .replace(/\//g, "\\/");
    this.routes.push({ method, regex: new RegExp(`^${regexStr}\\/?$`), paramNames, handler });
    return this;
  }

  get(pattern, handler) { return this._add("GET", pattern, handler); }
  post(pattern, handler) { return this._add("POST", pattern, handler); }
  put(pattern, handler) { return this._add("PUT", pattern, handler); }
  delete(pattern, handler) { return this._add("DELETE", pattern, handler); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
      return { handler: route.handler, params };
    }
    return null;
  }
}

module.exports = Router;
