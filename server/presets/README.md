# 提示词同步服务端（纯静态）

给插件的「**从服务器同步提示词**」功能提供内容。**不需要跑服务、不需要数据库** ——
两个文件丢到任意 HTTPS 静态托管上就能用。

---

## 怎么用

```bash
# 1. 改预设内容（只改这一个文件）
vim server/presets/presets.json

# 2. 校验并生成产物
node server/presets/sync.mjs

# 3. 把 public/ 里的内容上传到网站根目录
#    （要的效果是 https://你的域名/api/presets/manifest 能访问到）
```

然后在 Photoshop 里：**设置 → 提示词同步服务器** 填 `https://你的域名`，
点「从服务器同步提示词」。

> 必须 **HTTPS**。H5 版部署在 https 站点上时，浏览器会拦掉对 `http://` 的请求
> （混合内容策略）。本机自测可以用 `http://127.0.0.1:端口`，只有 UXP 端能用。

---

## 目录

```
server/presets/
├── presets.json                    ← 唯一源文件，改这个
├── sync.mjs                        ← 零依赖校验 + 生成
├── public/                         ← 部署这个目录**里面的内容**
│   └── api/presets/manifest        ← 产物（也进版本库，方便直接拖走）
└── README.md
```

`sync.mjs` 用的都是 `node:` 内置模块，不需要 `npm install`。
写法照 `_dev/prompt-sources/build-hemi-prompts.js` 的惯例：改源文件 → 跑脚本 → 产物写回。

---

## 接口契约

插件里 `syncServerPresets()` 实际请求的是这两个：

| 请求 | 说明 |
|---|---|
| `GET {baseUrl}/api/presets/manifest` | 主接口。返回 200 + JSON |
| `GET {baseUrl}/api/presets` | 只在上面那个返回 **404** 时回退。用不到可以不建 |
| `GET {baseUrl}/api/presets/{file}` | 只有 manifest 项**没带 prompt** 时才会请求（会用 `encodeURIComponent` 编码文件名） |

**响应体格式**（顶层四种都认，本仓库产物用第一种）：

```json
[
  { "name": "预设名", "category": "分类", "prompt": "提示词正文" }
]
```

也接受 `{"presets": [...]}` / `{"items": [...]}` / `{"files": [...]}`。

### 每个字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 预设名，会出现在下拉里 |
| `prompt` | ✅ | **必须是干净的非空字符串** |
| `category` | | 默认 `"服务器"`，会出现在分类下拉里 |
| `refImages` | | 参考图数组。**只放公网 https 地址**，别放 base64 |

**写了也没用的字段**：`subCategory`、`description`、`source`、`_cloudFile` ——
插件落盘前会剥掉它们。

### 三个容易踩的点

**1. `prompt` 必须是字符串，不能是对象或数组。**
插件的 `extractPresetPromptText()` 对对象会按字段逐条拼接，还会给正/反向词加上
「正向提示词：」「反向提示词：」这类前缀 —— 出来的是混合文本，不是你要发的内容。
对数组会用换行拼起来，对数字则**提取不出内容、整条被静默丢弃**。

**2. front-matter 不会被剥掉。**
`---\ntitle: x\n---\n正文` 会被当成一整段提示词发出去，连 `---` 和 `title:` 一起。
`sync.mjs` 会对这种内容发警告。

**3. 别和内置预设重名 —— 这条最隐蔽。**
插件合并预设时服务端排在**最后**，而去重规则是「**同名无条件丢弃后来的**」。
所以只要名字撞上内置的 68 条（`assets/presets/yushe.json`）或用户自己存的，
这条云端预设就**被静默吃掉** —— 不报错、不提示，用户只会觉得「我明明配了怎么没有」。
`sync.mjs` 会直接拦下这种名字。

---

## 为什么 manifest 要内嵌 prompt

插件解析 manifest 时是**串行**的：每一项如果没有正文字段，就会为它单独发一次
`GET /api/presets/{file}`，一条一条来。100 条预设 = 100 个来回。

把 `prompt` 直接写进 manifest，客户端就一条详情请求都不用发。

## 流量特征

插件在**两个时机**会全量拉一次 manifest：

- 插件启动时
- **每次切到「生成」页时**

所以建议在你的托管上给 `manifest` 加 `Cache-Control`（比如 `max-age=300`）。
插件端没有做本地缓存，也没有设超时 —— 服务端别做慢响应，否则同步按钮会一直转。

## 跨域

插件在 UXP 里跑时不受同源策略限制，但 **H5 / PWA 版是真浏览器**，同一份代码两端共用。
静态托管一般默认就带 `Access-Control-Allow-Origin: *`；如果自己配 nginx，记得加上：

```nginx
location /api/presets/ {
    add_header Access-Control-Allow-Origin *;
    add_header Cache-Control "public, max-age=300";
    default_type application/json;
}
```

---

## 各家托管的主意事项

`manifest` 是**无扩展名**的文件，客户端要的就是这个路径。多数静态托管直接就能服务它，
只是 `Content-Type` 会是 `application/octet-stream` —— **不影响**，插件是用
`response.json()` 解析的，不看类型头。

少数托管平台会拒绝服务无扩展名文件，那就改用 rewrite：

**Netlify** —— `_redirects`：

```
/api/presets/manifest  /api/presets/manifest.json  200
```

**Vercel** —— `vercel.json`：

```json
{ "rewrites": [{ "source": "/api/presets/manifest", "destination": "/api/presets/manifest.json" }] }
```

**nginx**：

```nginx
location = /api/presets/manifest {
    alias /var/www/presets/manifest.json;
    default_type application/json;
}
```

用 rewrite 的话，把产物同时留一份 `.json` 副本即可。

---

## 不想自己写内容？

`presets.json` 里那两条 `云示例·…` 只是格式示例，删掉换成你自己的。
也可以直接把 `assets/presets/yushe.json` 那 68 条改个名字搬过来 ——
但**必须改名**，同名会被丢弃（原因见上）。
