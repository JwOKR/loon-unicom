# 中国联通 Token#AppId —— Loon 自动获取插件

打开联通 APP 走一次登录，Loon 自动把 `token_online` 和 `appId` 抓出来，拼成脚本要的

```
token_online#appId
```

存进本机，并可自动写进青龙面板的 `chinaUnicomCookie`，供 `中国联通_v1.2.1.py` 这类脚本直接跑。

```
联通 APP ──HTTPS──▶ Loon(MITM) ──▶ 脚本提取 token_online / appId
                                        │
                                        ├─▶ Loon 持久化存储（本机留底）
                                        ├─▶ 通知（手机弹窗）
                                        └─▶ 青龙 OpenAPI 更新环境变量 chinaUnicomCookie
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `chinaUnicom.token.plugin` | Loon 插件本体（MITM 主机名 + 两条脚本规则） |
| `chinaUnicom.token.js` | 抓取/校验/同步逻辑，配置项在文件顶部 `CFG` |
| `README.md` | 本说明 |

## 一、地址（已托管，直接用）

插件里的 `script-path` 预填的是 **jsDelivr 固定版本**（版本号写死在 URL 里，不会被 CDN 缓存串成旧版）：

```
https://cdn.jsdelivr.net/gh/JwOKR/loon-unicom@v1.0.6/chinaUnicom.token.js
```

jsDelivr 打不开时，把插件里**三处** `script-path` 换成 raw（raw 走 GitHub 自己的 CDN，刚 push 完
可能有几分钟延迟，属正常）：

| 优先级 | 地址 |
| --- | --- |
| 1 | `https://cdn.jsdelivr.net/gh/JwOKR/loon-unicom@v1.0.6/chinaUnicom.token.js` |
| 2 | `https://raw.githubusercontent.com/JwOKR/loon-unicom/v1.0.5/chinaUnicom.token.js` |
| 3 | 本地文件：把 JS 存到「文件 → iCloud Drive → Loon → Script」，改成 `script-path=chinaUnicom.token.js` |

## 二、安装插件

Loon → 首页 → **插件** → 右上角 **+**

- **在线安装**：填插件地址
  `https://cdn.jsdelivr.net/gh/JwOKR/loon-unicom@v1.0.6/chinaUnicom.token.plugin`
  不通时用 `https://raw.githubusercontent.com/JwOKR/loon-unicom/v1.0.5/chinaUnicom.token.plugin`
- **本地安装**：把 `.plugin` 存到「文件」App，选「从文件导入」

装好后**必须确认这两处**，否则等于没装：

1. 插件详情里能看到两条脚本：`联通Token登录响应`、`联通Token查看`
2. Loon 首页 → **脚本** 列表里也能看到这两条（不是灰色/不是"下载失败"）

> `联通Token登录响应` 只匹配 `*/mobileService/login.htm`、`onLine.htm`、`logon.htm`，
> **只有登录那一刻才会跑**；平时刷 APP 没有任何脚本运行，这是正常的。

## 三、开启 MITM（关键，不开则抓不到）

1. Loon → **设置** → **MitM** → 打开开关 → 生成/安装证书
2. iOS → **设置** → 通用 → VPN与设备管理 → 安装描述文件
3. iOS → **设置** → 通用 → 关于本机 → **证书信任设置** → 打开 Loon 证书

## 四、（可选）自动同步青龙

编辑 `chinaUnicom.token.js` 顶部的 `CFG`：

```js
qlUrl: "http://192.168.1.10:5700",   // 你的青龙地址，结尾不要 /
qlClientId: "xxxxxxxx",              // 青龙 → 系统设置 → 应用设置 → 新建应用
qlClientSecret: "yyyyyyyy",          // 该应用权限勾选「环境变量」
qlEnvName: "chinaUnicomCookie",
```

不填也能用：token 只存在手机里 + 弹通知，手动复制到青龙。

> 青龙 2.10+ 的 OpenAPI 用 `PUT /open/envs` 更新变量；个别老版本 Loon 的 `$httpClient` 没有 `put`，
> 此时会提示「当前 Loon 不支持 PUT」，升级 Loon 即可，或改用 `webhookUrl` 推给你自己的服务。

## 五、怎么确认抓没抓到

三种方式，从快到慢：

**① 弹窗（最直接）**

抓到并验证通过会弹：`联通 Token 已更新 ✅ 186****0001 已验证可用（code=0）`。
没弹窗 = 没抓到，或抓到了但验证失败（会弹 `验证失败 ❌ code=xxx`）。

**② 点一下「联通Token查看」（最可靠）**

Loon → 首页 → **脚本** → 找到 `联通Token查看` → 点运行。它会弹通知告诉你：

```
联通 Token 状态
共 1 个账号
1. 186****0001 | 已验证 | 10-12 22:31
```

同时把完整值打到 Loon 日志：

```
[联通Token] chinaUnicomCookie = 3f9c…(token)#0f4af…(appId)
```

显示「还没有抓到」就说明确实没捕获到。如果配了青龙，点这一下还会顺手把当前值再推一次。

**③ 看青龙**

青龙 → 环境变量 → `chinaUnicomCookie`，值应该是 `Token#AppId` 形式。

> 注意：`token_online` **只在登录响应里出现**（不在 Cookie、不在请求体），所以只有走一次登录
> 才会更新。token 有效期不短，掉登录后重登一次即可，不用天天抓。

## 六、和 Python 脚本怎么配合

Python 版解析逻辑（`init_account`）是：

```python
parts = config_str.split('#')
token_online = parts[0]
appId        = parts[1]        # 有就带上，属于「Token#AppId 模式」
```

所以：

- **单账号**：`chinaUnicomCookie = "token#appId"`，插件已按这个格式写入
- **多账号**：脚本用 `re.split(r'[&\n]', ...)` 拆分，插件也用 `&` 连接，最多保留 `CFG.maxAccounts`（默认 5）个
- **appId 抓不到时**：插件用与 Python `generate_appid()` **完全相同**的模板补一个（10 位随机 + 147 位固定块 + 2 位随机）；万一服务端不认这个补的 appId，会自动**回退成纯 Token** 再验证一次并保存，不会卡死
- **本地缓存**：Python 版会把 token 按手机号缓存 12 小时，插件更新环境变量后，下一轮定时任务自然用新值

定时任务照旧，比如 `0 7,20 * * *` 一天两跑。

## 七、抓不到怎么办

| 现象 | 原因 / 处理 |
| --- | --- |
| 运行记录里没有脚本在跑 | 正常：`联通Token登录响应` 只在登录接口出现时才跑，平时刷 APP 不会有记录 |
| 插件装了，但插件详情里没有脚本条目 / 条目变灰 | ① 语法不对（本插件用的是 Loon 旧语法 `http-response <正则> script-path=...`，不是 Surge 的 `type=http-response, pattern=...`）；② 脚本下载失败，换 §一 里的镜像，或改成本地文件 |
| 完全没通知、日志也没 `[联通Token]` | MITM 没开 / 证书没信任 / 插件没启用；先随便打开一个网页确认 Loon 能抓 HTTPS |
| 其他 APP 能抓，联通不行 | 联通 APP 某些版本有证书绑定（SSL Pinning），Loon 无法绕过。改用安卓抓包手动取，见下 |
| 通知 `验证失败 code=xxx` | token 已过期或被顶号，重新「退出登录 → 切换账号登录」再抓一次 |
| 通知 `已保存（未配置青龙/Webhook）` | 正常，只存本机；去 Loon 日志复制完整值 |
| 想清空重来 | 删除持久化键 `unicom_token_map` 与 `unicom_token_current`（Loon 设置里的持久化数据），或把 `CFG.maxAccounts` 调小后重新抓 |

**手动兜底（安卓）**：Reqable / HttpCanary 抓 `POST https://loginxx.10010.com/mobileService/login.htm`
（或 `.../onLine.htm`）的**响应**，JSON 里 `token_online` 和 `appId` 都是明文，拼成 `token#appId` 填青龙。

## 七点五、抓包实测结论（754 条 Loon 记录）

| 项 | 实际情况 |
| --- | --- |
| `token_online` 在哪 | **只在登录接口的响应 JSON 里**，长度 704，纯小写十六进制 |
| Cookie 里有吗 | 没有（Cookie 里是 `ecs_token` / `t3_token` / `u_account` / `c_mobile`） |
| 请求体里有吗 | 没有（请求体是整段加密 base64） |
| 登录接口 | `loginxx.10010.com/mobileService/login.htm` 和 `.../onLine.htm` |
| `appId` | 同一条响应里，长度 192，与 `token_online` 成对出现 |
| 手机号 | `desmobile` 是 `enc_` 密文，真号码取 Cookie 的 `u_account` / `c_mobile` |

## 八、注意

- 抓包等于把你的登录态交给脚本，**别把日志里的 token 发给别人**，也别提交到公开仓库
- 插件只用 `GET/POST/PUT` 调你自己的青龙，不向任何第三方发送数据
- 频繁登录/异地登录可能触发联通风控，够用就别反复重登
- 仅供个人学习自用，账号风险自负

## 九、自测记录

`chinaUnicom.token.js` 已用 Node 跑过两组用例，全部通过：

- **解析/存储** 20 项：表单与 JSON 解析、Cookie 提取、onLine 请求体提取、appId 生成结构（10+147+2 位，与 Python `generate_appid()` 一致）、去重、多账号 `&` 合并、手机号换 key、非法 token 拦截
- **流程模拟** 14 项：模拟 Loon 的 `$request/$response/$httpClient/$notification`，覆盖 Cookie 抓取→验证→写入、登录响应直接取手机号、重复请求静默、登录失败不落盘、模板 appId 被拒后自动回退纯 Token



