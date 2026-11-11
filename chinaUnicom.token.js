/**
 * ============================================================================
 *  中国联通 Token#AppId 自动获取  ——  Loon 脚本  v1.0.0
 *  配套插件：chinaUnicom.token.plugin
 * ----------------------------------------------------------------------------
 *  原理
 *    联通 APP 与 m.client.10010.com 通信时会带 token_online 与 appId。
 *    本脚本在 Loon MITM 的请求/响应里提取这两个值，拼成
 *
 *        token_online#appId
 *
 *    写入 Loon 持久化存储；可选再调用 onLine.htm 验证并取回手机号；
 *    可选同步到青龙面板环境变量 chinaUnicomCookie（供 Python 版直接使用）。
 *
 *  注意
 *    Loon 必须开启 MitM 并信任证书，否则抓不到 HTTPS 内容。
 * ============================================================================
 */

/* ============================== 用户配置 ============================== */
const CFG = {
  // ---- 青龙面板（可选）。三项都填才会自动同步，否则只在本机保存 + 通知 ----
  qlUrl: "",              // 例：http://192.168.1.10:5700（结尾不要带 /）
  qlClientId: "",         // 青龙 → 系统设置 → 应用设置 → 新建应用
  qlClientSecret: "",     // 该应用权限勾选「环境变量」
  qlEnvName: "chinaUnicomCookie",

  // ---- 通用 webhook（可选，配置后除青龙外再推一份；GET 自动拼 ?value=）----
  webhookUrl: "",

  // ---- 行为开关 ----
  autoAppId: true,        // 抓不到 appId 时用联通模板补一个（同 Python 版 generate_appid）
  verify: true,           // 抓到后调用 onLine.htm 验证（多一次登录请求，介意可关）
  notify: true,           // 是否发系统通知
  maxAccounts: 5,         // 最多保留几个账号
  debug: true,            // Loon 日志里打印细节
};
/* ==================================================================== */

const UA = "Dalvik/2.1.0 (Linux; U; Android 12; Mi 10 Pro MIUI/21.11.3);unicom{version:android@11.0802}";
const ON_LINE = "https://m.client.10010.com/mobileService/onLine.htm";
const K_MAP = "unicom_token_map";
const K_CUR = "unicom_token_current";
const K_BAD = "unicom_token_bad";     // 验证失败的 token，30 分钟内不再重试，避免通知轰炸
const BAD_TTL = 30 * 60 * 1000;

/* appId 模板：与 Python 版 generate_appid() 完全一致 */
const APPID_FIXED =
  "912d306b5053abf90c7ebbb695887bc" +
  "870ae0706d573c348539c26c5c0a878641fcc0d3e90acb9be1e6ef858a" +
  "59af546f3c826988332376b7d18c8ea2398ee3a9c3db947e2471d32a49";

/* ------------------------------ 基础工具 ------------------------------ */

function log() {
  if (!CFG.debug) return;
  try {
    console.log("[联通Token] " + Array.prototype.slice.call(arguments).join(" "));
  } catch (e) { /* ignore */ }
}

function pad2(n) { return n < 10 ? "0" + n : "" + n; }

function nowStr() {
  var d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function randHex(n) {
  var s = "", hex = "0123456789abcdef";
  for (var i = 0; i < n; i++) s += hex.charAt(Math.floor(Math.random() * 16));
  return s;
}

/* 对象键统一小写，便于大小写不敏感取值 */
function lc(obj) {
  var out = {};
  if (!obj) return out;
  for (var k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[String(k).toLowerCase()] = obj[k];
  }
  return out;
}

/* a=1&b=2 -> {a:"1", b:"2"} */
function parseForm(str) {
  var out = {};
  if (!str || typeof str !== "string") return out;
  var parts = str.split("&");
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i];
    var idx = kv.indexOf("=");
    if (idx < 0) continue;
    try {
      var k = decodeURIComponent(kv.slice(0, idx).replace(/\+/g, " "));
      var v = decodeURIComponent(kv.slice(idx + 1).replace(/\+/g, " "));
      out[k] = v;
    } catch (e) { /* ignore */ }
  }
  return out;
}

/* 同时兼容 form 与 json body */
function parseBody(body, contentType) {
  var out = {};
  if (!body || typeof body !== "string") return out;
  var ct = String(contentType || "").toLowerCase();
  if (ct.indexOf("json") >= 0 || /^\s*\{/.test(body)) {
    try {
      var j = JSON.parse(body);
      if (j && typeof j === "object" && !(j instanceof Array)) {
        for (var k in j) if (Object.prototype.hasOwnProperty.call(j, k)) out[k] = j[k];
      }
    } catch (e) { /* ignore */ }
  }
  var form = parseForm(body);
  for (var f in form) if (Object.prototype.hasOwnProperty.call(form, f)) out[f] = form[f];
  return out;
}

/* 从 Cookie 头里取某个键 */
function cookieOf(headers, name) {
  var h = lc(headers);
  var raw = h["cookie"] || "";
  var target = String(name).toLowerCase();
  var parts = String(raw).split(";");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    var idx = p.indexOf("=");
    if (idx < 0) continue;
    if (p.slice(0, idx).trim().toLowerCase() === target) return p.slice(idx + 1).trim();
  }
  return "";
}

function looksToken(v) {
  if (!v) return false;
  v = String(v).trim();
  if (v.length < 16 || v.length > 200) return false;
  return /^[0-9A-Za-z_.\-]+$/.test(v);
}

function maskMobile(m) {
  if (!m) return "";
  if (/^1\d{10}$/.test(m)) return m.slice(0, 3) + "****" + m.slice(7);
  return String(m);
}

/* ------------------------------ 持久化 ------------------------------ */

function readMap() {
  try {
    var s = $persistentStore.read(K_MAP);
    if (!s) return {};
    var o = JSON.parse(s);
    return (o && typeof o === "object") ? o : {};
  } catch (e) { return {}; }
}

function writeMap(map) {
  try { $persistentStore.write(JSON.stringify(map), K_MAP); } catch (e) { log("写存储失败", e); }
}

function mapValues(map) {
  var arr = [];
  for (var k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k) && map[k] && map[k].cookie) arr.push(map[k]);
  }
  arr.sort(function (a, b) { return (a.time || 0) - (b.time || 0); });
  return arr;
}

function findSame(token, appId) {
  var map = readMap();
  for (var k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    var it = map[k];
    if (it && it.token === token && it.appId === appId) return it;
  }
  return null;
}

function knownEntry(token) {
  var map = readMap();
  for (var k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    if (map[k] && map[k].token === token) return map[k];
  }
  return null;
}

/* 验证失败的 token 记忆，避免每次请求都弹“验证失败” */
function badRecently(token) {
  try {
    var o = JSON.parse($persistentStore.read(K_BAD) || "{}");
    var t = o[token];
    return !!(t && (Date.now() - t) < BAD_TTL);
  } catch (e) { return false; }
}

function markBad(token) {
  try {
    var o = {};
    try { o = JSON.parse($persistentStore.read(K_BAD) || "{}"); } catch (e) { o = {}; }
    o[token] = Date.now();
    var keep = {}, limit = 7 * 24 * 60 * 60 * 1000;
    for (var k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k) && o[k] && (Date.now() - o[k]) < limit) keep[k] = o[k];
    }
    $persistentStore.write(JSON.stringify(keep), K_BAD);
  } catch (e) { /* ignore */ }
}

/**
 * 落盘：同 token 视为同一账号（换 key 时删除旧记录），超出上限按时间淘汰最旧。
 * @returns {{value:string, changed:boolean, entry:object}}
 */
function commit(entry) {
  var map = readMap();
  var prev = map[entry.key] || null;

  // 清掉 7 天前的旧记录，避免换 token 后越积越多
  var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (var k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    if (k !== entry.key && map[k] && map[k].time && map[k].time < cutoff) delete map[k];
  }

  // 同一 token 换了 key（例如刚识别到手机号），先清掉旧的
  for (var k2 in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k2)) continue;
    if (k2 !== entry.key && map[k2] && map[k2].token === entry.token) delete map[k2];
  }

  var merged = {};
  if (prev) for (var p in prev) if (Object.prototype.hasOwnProperty.call(prev, p)) merged[p] = prev[p];
  for (var n in entry) if (Object.prototype.hasOwnProperty.call(entry, n)) merged[n] = entry[n];
  merged.time = Date.now();
  if (!merged.verified) merged.verified = (prev && prev.verified) || 0;

  map[entry.key] = merged;

  var all = mapValues(map);
  if (all.length > CFG.maxAccounts) {
    for (var i = 0; i < all.length - CFG.maxAccounts; i++) delete map[all[i].key];
  }

  writeMap(map);

  var value = mapValues(map).map(function (x) { return x.cookie; }).join("&");
  try { $persistentStore.write(value, K_CUR); } catch (e) { /* ignore */ }

  var changed = !prev ||
    prev.cookie !== merged.cookie ||
    (!!merged.mobile && prev.mobile !== merged.mobile);
  return { value: value, changed: !!changed, entry: merged };
}

/* ------------------------------ 抓取解析 ------------------------------ */

function extractFromRequest(req) {
  req = req || {};
  var url = String(req.url || "");
  var h = lc(req.headers);

  var qi = url.indexOf("?");
  var query = parseForm(qi >= 0 ? url.slice(qi + 1) : "");
  var body = parseBody(req.body, h["content-type"]);

  var all = {};
  var src = [lc(query), lc(body)];
  for (var s = 0; s < src.length; s++) {
    for (var k in src[s]) if (Object.prototype.hasOwnProperty.call(src[s], k)) all[k] = src[s][k];
  }

  var token = all["token_online"] || all["tokenonline"] || "";
  if (!token) token = cookieOf(req.headers, "token_online");
  if (!token) token = h["token_online"] || h["x-token-online"] || "";
  if (!token && looksToken(h["token"])) token = h["token"];

  var appId = all["appid"] || "";
  if (!appId) appId = cookieOf(req.headers, "appId");
  if (!appId) appId = h["appid"] || h["app-id"] || h["x-appid"] || "";

  return { token: String(token || "").trim(), appId: String(appId || "").trim() };
}

/* 生成 appId：与 Python 版 generate_appid() 相同模板 */
function genAppId() {
  var d = function () { return Math.floor(Math.random() * 10); };
  return String(d()) + "f" + d() + "af" + d() + d() + "ad" + d() + APPID_FIXED + d() + d();
}

function makeEntry(token, appId) {
  token = String(token || "").trim();
  appId = String(appId || "").trim();
  if (!looksToken(token)) return null;

  var aid = "";
  var synthetic = false;
  if (appId && appId.length >= 20) {
    aid = appId;                                  // 真·抓到的 appId
  } else {
    var known = knownEntry(token);
    if (known && known.appId) {
      aid = known.appId;                          // 之前给这个 token 用过的
      synthetic = !!known.synthetic;
    } else if (CFG.autoAppId) {
      aid = genAppId();                           // 先用模板补一个，验证不过会自动回退成纯 Token
      synthetic = true;
    }
  }

  return {
    key: "tk_" + token.slice(0, 16),
    mobile: "",
    token: token,
    appId: aid,
    synthetic: synthetic,
    cookie: aid ? token + "#" + aid : token,
    time: Date.now(),
    verified: 0,
  };
}

/* ------------------------------ 通知 / 同步 ------------------------------ */

function notify(title, sub, body) {
  if (!CFG.notify) return;
  try { $notification.post(String(title || ""), String(sub || ""), String(body || "")); } catch (e) { /* ignore */ }
}

function finish(entry, opt) {
  opt = opt || {};
  var r = commit(entry);
  log("chinaUnicomCookie =", r.value);
  if (!r.changed && !opt.force) { log("内容未变化，跳过通知"); return; }

  var sub = maskMobile(entry.mobile) || "已保存";
  var head = opt.title || "联通 Token 已更新 ✅";
  var extra = opt.body ? opt.body + "\n" : "";

  var tasks = [];
  if (CFG.qlUrl) tasks.push(function (next) { qlSync(r.value, next); });
  if (CFG.webhookUrl) tasks.push(function (next) { webhookSync(r.value, next); });

  if (!tasks.length) {
    notify(head, sub, extra + "仅保存在本机（未配置青龙/Webhook）");
    return;
  }

  var results = [];
  var i = 0;
  (function step() {
    if (i >= tasks.length) {
      notify(head, sub, extra + results.join("\n"));
      return;
    }
    tasks[i++](function (msg) { results.push(msg); step(); });
  })();
}

/* 通用 webhook：GET 拼 ?value=，否则 POST JSON */
function webhookSync(value, cb) {
  var url = CFG.webhookUrl;
  var json = JSON.stringify({ name: CFG.qlEnvName, value: value, time: nowStr() });
  try {
    if (/\?/.test(url)) {
      $httpClient.post({ url: url, headers: { "Content-Type": "application/json" }, body: json, timeout: 15 },
        function (err) { cb(err ? "Webhook 失败：" + err : "Webhook 已推送 ✅"); });
    } else {
      $httpClient.get({ url: url + "?value=" + encodeURIComponent(value), timeout: 15 },
        function (err) { cb(err ? "Webhook 失败：" + err : "Webhook 已推送 ✅"); });
    }
  } catch (e) { cb("Webhook 异常"); }
}

/* 青龙 OpenAPI 同步 */
function qlSync(value, cb) {
  var base = String(CFG.qlUrl || "").replace(/\/+$/, "");
  if (!base) return cb("未配置青龙");

  var authUrl = base + "/open/auth/token?client_id=" + encodeURIComponent(CFG.qlClientId) +
    "&client_secret=" + encodeURIComponent(CFG.qlClientSecret);

  $httpClient.get({ url: authUrl, timeout: 15 }, function (e1, r1, d1) {
    var tk = "";
    try { tk = (JSON.parse(d1).data || {}).token || ""; } catch (e) { /* ignore */ }
    if (!tk) return cb("青龙鉴权失败（检查地址/ID/Secret）");

    var H = { "Authorization": "Bearer " + tk, "Content-Type": "application/json" };
    var listUrl = base + "/open/envs?searchValue=" + encodeURIComponent(CFG.qlEnvName);

    $httpClient.get({ url: listUrl, headers: H, timeout: 15 }, function (e2, r2, d2) {
      var list = [];
      try {
        var j = JSON.parse(d2);
        list = (j && j.data instanceof Array) ? j.data : [];
      } catch (e) { /* ignore */ }

      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].name === CFG.qlEnvName) { hit = list[i]; break; }
      }

      var payload = { name: CFG.qlEnvName, value: value, remarks: "Loon 自动更新 " + nowStr() };

      var enable = function (id) {
        if (!id) return cb("青龙写入失败");
        if (typeof $httpClient.put !== "function") return cb("已写入青龙（当前 Loon 不支持自动启用，请手动启用）");
        $httpClient.put({
          url: base + "/open/envs/enable",
          headers: H,
          body: JSON.stringify([id]),
          timeout: 15,
        }, function () { cb("已同步青龙 ✅"); });
      };

      if (hit && hit.id) {
        if (typeof $httpClient.put !== "function") return cb("当前 Loon 不支持 PUT，无法更新青龙");
        payload.id = hit.id;
        $httpClient.put({
          url: base + "/open/envs",
          headers: H,
          body: JSON.stringify(payload),
          timeout: 15,
        }, function (e3, r3, d3) {
          var ok = false;
          try { ok = JSON.parse(d3).code === 200; } catch (e) { /* ignore */ }
          if (!ok) return cb("青龙更新失败");
          enable(hit.id);
        });
      } else {
        $httpClient.post({
          url: base + "/open/envs",
          headers: H,
          body: JSON.stringify([payload]),
          timeout: 15,
        }, function (e4, r4, d4) {
          var id = null;
          try {
            var j4 = JSON.parse(d4);
            if (j4.code === 200 && j4.data instanceof Array && j4.data[0]) id = j4.data[0].id;
          } catch (e) { /* ignore */ }
          enable(id);
        });
      }
    });
  });
}

/* ------------------------------ 验证 token ------------------------------ */

function verify(entry, retried) {
  var fields = [
    "isFirstInstall=1",
    "netWay=Wifi",
    "version=android@11.0802",
    "token_online=" + encodeURIComponent(entry.token),
    entry.appId ? "appId=" + encodeURIComponent(entry.appId) : "",
    "provinceChanel=general",
    "deviceModel=ALN-AL10",
    "step=dingshi",
    "androidId=" + randHex(16),
    "reqtime=" + Date.now(),
  ].filter(function (x) { return !!x; });

  $httpClient.post({
    url: ON_LINE,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
      "X-UC-Probe": "1",
    },
    body: fields.join("&"),
    timeout: 15,
  }, function (err, resp, data) {
    if (err) {
      // 探测失败多半是网络/规则问题，token 本身可能有效，先保存
      finish(entry, { title: "联通 Token 已抓取 ⚠️", body: "验证请求失败：" + String(err) });
      return;
    }
    var j = null;
    try { j = JSON.parse(data); } catch (e) { /* ignore */ }
    var code = j ? String(j.code) : "";

    if (code === "0" || code === "0000") {
      var mobile = (j && (j.desmobile || j.mobile)) || "";
      var e2 = {};
      for (var k in entry) if (Object.prototype.hasOwnProperty.call(entry, k)) e2[k] = entry[k];
      if (/^1\d{10}$/.test(mobile)) { e2.mobile = mobile; e2.key = mobile; }
      e2.verified = Date.now();
      finish(e2, { title: "联通 Token 已更新 ✅", body: "已验证可用（code=0）" });
    } else {
      // 模板 appId 不被接受时，回退成「纯 Token」再试一次（Python 版旧模式，实测可用）
      if (entry.synthetic && !retried) {
        log("模板 appId 未通过，回退纯 Token 重试");
        var e2 = {};
        for (var kk in entry) if (Object.prototype.hasOwnProperty.call(entry, kk)) e2[kk] = entry[kk];
        e2.appId = "";
        e2.synthetic = false;
        e2.cookie = e2.token;
        return verify(e2, true);
      }
      var msg = j ? (j.msg || j.desc || "") : "";
      markBad(entry.token);
      notify("联通 Token 验证失败 ❌", "code=" + (code || "?"), msg || "请重新登录联通 APP 后再试");
    }
  });
}

/* ------------------------------ 入口 ------------------------------ */

function handleRequest() {
  var req = $request || {};
  var finished = false;
  try {
    var h = lc(req.headers);
    if (h["x-uc-probe"]) return $done({});          // 自家验证请求，跳过

    var got = extractFromRequest(req);
    if (!got.token) return $done({});

    var entry = makeEntry(got.token, got.appId);
    if (!entry) return $done({});
    if (badRecently(entry.token)) return $done({});            // 刚验证失败过，别再骚扰
    if (findSame(entry.token, entry.appId)) return $done({});   // 抓过，跳过

    $done({});                                       // 先放行，别卡住 APP
    finished = true;

    log("命中请求:", req.url);
    log("token:", entry.token.slice(0, 12) + "…", "appId:", entry.appId ? entry.appId.slice(0, 12) + "…" : "(空)");

    if (CFG.verify) verify(entry);
    else finish(entry, { title: "联通 Token 已抓取", body: "未验证" });
  } catch (e) {
    log("handleRequest 异常:", e);
    if (!finished) { try { $done({}); } catch (e2) { /* ignore */ } }
  }
}

function handleResponse() {
  var req = $request || {};
  var resp = $response || {};
  var finished = false;
  try {
    var rh = lc(req.headers);
    if (rh["x-uc-probe"]) { $done({}); return; }     // 自家验证请求的响应

    var body = resp.body || "";
    var j = null;
    try { j = JSON.parse(body); } catch (e) { /* ignore */ }

    var got = extractFromRequest(req);
    var token = got.token;
    var appId = got.appId;
    var mobile = "";

    if (j && typeof j === "object") {
      if (!token) token = j.token_online || j.token || "";
      if (!appId) appId = j.appId || "";
      mobile = j.desmobile || j.mobile || "";
    }
    if (!token) {
      var sh = lc(resp.headers);
      var m = /token_online=([^;,\s]+)/i.exec(String(sh["set-cookie"] || ""));
      if (m) token = m[1];
    }

    var code = j ? String(j.code) : "";
    var bad = code && code !== "0" && code !== "0000";

    var entry = makeEntry(token, appId);
    $done({});                                        // 立即放行响应
    finished = true;

    if (!entry || bad) return;                        // 登录失败的响应不保存
    if (/^1\d{10}$/.test(mobile)) { entry.mobile = mobile; entry.key = mobile; }
    entry.verified = Date.now();

    log("登录响应命中:", req.url, "code=", code, "mobile=", maskMobile(mobile));
    finish(entry, { title: "联通 Token 已更新 ✅", body: "来自登录响应" });
  } catch (e) {
    log("handleResponse 异常:", e);
    if (!finished) { try { $done({}); } catch (e2) { /* ignore */ } }
  }
}

(function main() {
  var hasResp = (typeof $response !== "undefined") && !!$response &&
    (typeof $response === "object") &&
    ("status" in $response || "body" in $response || "headers" in $response);
  if (hasResp) return handleResponse();
  if (typeof $request !== "undefined" && $request) return handleRequest();
})();

/* 本地 Node 自测用（Loon 里不存在 module，无副作用） */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CFG: CFG,
    parseForm: parseForm,
    parseBody: parseBody,
    cookieOf: cookieOf,
    extractFromRequest: extractFromRequest,
    genAppId: genAppId,
    makeEntry: makeEntry,
    commit: commit,
    readMap: readMap,
  };
}
