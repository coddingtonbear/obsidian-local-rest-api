# Local REST API with MCP

> **English version:** See [`README.md`](README.md)

为你的脚本、浏览器扩展和 AI 代理提供一条通过安全、经过身份验证的 REST API 直接访问 Obsidian 知识库的通道。

**交互式 API 文档：** https://coddingtonbear.github.io/obsidian-local-rest-api/

## 功能介绍

通过 **REST API** 或 **内置的 [MCP 服务器](https://modelcontextprotocol.io/)** 访问你的知识库——两个接口提供相同的核心能力，脚本、浏览器扩展和 AI 代理都能使用同一套接口。

- **读取、创建、更新或删除笔记**——对知识库中的任何文件（包括二进制文件）进行完整 CRUD 操作
- **精准修改特定部分**——针对标题、块引用或 frontmatter 键进行追加、前置或替换，不触碰文件的其余部分
- **搜索知识库**——简单的全文搜索或基于 [JsonLogic](https://jsonlogic.com/) 的结构化查询（可针对 frontmatter、标签、路径、内容）
- **访问当前打开的文件**——读取或写入 Obsidian 中当前打开的笔记
- **处理周期性笔记**——获取或创建日、周、月、季度和年度笔记
- **列出和执行命令**——像使用命令面板一样触发任何 Obsidian 命令
- **查询标签**——列出知识库中所有标签及其使用次数
- **在 Obsidian 中打开文件**——告诉 Obsidian 在 UI 中打开指定笔记
- **扩展 API**——其他插件可以通过 [API 扩展接口](https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Adding-your-own-API-Routes-via-an-Extension) 注册自己的路由

所有请求均通过 HTTPS 提供服务，使用自签名证书，并通过 API 密钥进行身份验证。

## 快速开始

安装并启用插件后，打开 **设置 → Local REST API** 即可找到你的 API 密钥和证书。

### REST API

```sh
# 检查服务器是否运行（无需认证）
curl -k https://127.0.0.1:27124/

# 列出知识库根目录下的文件
curl -k -H "Authorization: Bearer <你的API密钥>" \
  https://127.0.0.1:27124/vault/

# 读取笔记
curl -k -H "Authorization: Bearer <你的API密钥>" \
  https://127.0.0.1:27124/vault/path/to/note.md

# 读取指定标题（URL 嵌入目标）
curl -k -H "Authorization: Bearer <你的API密钥>" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section

# 向指定标题追加一行（使用 PATCH 和请求头）
curl -k -X PATCH \
  -H "Authorization: Bearer <你的API密钥>" \
  -H "Operation: append" \
  -H "Target-Type: heading" \
  -H "Target: My Section" \
  -H "Content-Type: text/plain" \
  --data "New line of content" \
  https://127.0.0.1:27124/vault/path/to/note.md
```

为避免证书警告，你可以从 `https://127.0.0.1:27124/obsidian-local-rest-api.crt` 下载并信任该证书，或者直接让 HTTP 客户端忽略证书验证。

### MCP 客户端

MCP 服务器运行在 `https://127.0.0.1:27124/mcp/`，需要通过 `Authorization` 请求头提供 Bearer 令牌进行认证（即 `Authorization: Bearer <你的API密钥>`）。由于插件使用自签名证书，你可能需要信任该证书，或者使用纯 HTTP 端点 `http://127.0.0.1:27123/mcp/`（在 **设置 → Local REST API → Enable HTTP server** 中启用）。

#### Claude Code

Claude Code 原生支持 HTTP MCP。通过 CLI 添加服务器最快捷：

```sh
claude mcp add --transport http obsidian https://127.0.0.1:27124/mcp/ \
  --header "Authorization: Bearer <你的API密钥>"
```

或者手动添加到项目根目录的 `.mcp.json` 文件（项目级），或通过 `claude mcp add --scope user` 进行用户级配置：

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "https://127.0.0.1:27124/mcp/",
      "headers": {
        "Authorization": "Bearer <你的API密钥>"
      }
    }
  }
}
```

#### Claude Desktop

Claude Desktop 不原生支持远程 HTTP MCP 服务器，但可以通过 [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) 桥接（需要 Node.js）。将以下内容添加到 `claude_desktop_config.json`：

- **macOS：** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows：** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": [
        "mcp-remote@latest",
        "https://127.0.0.1:27124/mcp/",
        "--header",
        "Authorization: Bearer <你的API密钥>"
      ]
    }
  }
}
```

保存文件后重启 Claude Desktop。

#### Cursor

Cursor 支持 Streamable HTTP MCP 传输协议。将以下内容添加到 `~/.cursor/mcp.json`（全局）或 `.cursor/mcp.json`（项目级）：

```json
{
  "mcpServers": {
    "obsidian": {
      "url": "https://127.0.0.1:27124/mcp/",
      "headers": {
        "Authorization": "Bearer <你的API密钥>"
      }
    }
  }
}
```

#### 其他客户端

任何支持 Streamable HTTP 传输协议的 MCP 客户端都可以连接 `https://127.0.0.1:27124/mcp/`，并携带 `Authorization: Bearer <你的API密钥>` 请求头。具体配置格式请查阅客户端的文档。

## API 概览

| 端点 | 方法 | 说明 |
|---|---|---|
| `/vault/{path}` | GET PUT PATCH POST DELETE | 读取、写入或删除知识库中的任何文件 |
| `/active/` | GET PUT PATCH POST DELETE | 操作当前打开的文件 |
| `/periodic/{period}/` | GET PUT PATCH POST DELETE | 今天的周期性笔记（`daily`、`weekly` 等） |
| `/periodic/{period}/{year}/{month}/{day}/` | GET PUT PATCH POST DELETE | 指定日期的周期性笔记 |
| `/search/simple/` | POST | 在所有笔记中执行全文搜索 |
| `/search/` | POST | 通过 JsonLogic 进行结构化搜索 |
| `/commands/` | GET | 列出可用的 Obsidian 命令 |
| `/commands/{commandId}/` | POST | 执行命令 |
| `/tags/` | GET | 列出所有标签及其使用次数 |
| `/open/{path}` | POST | 在 Obsidian UI 中打开文件 |
| `/` | GET | 服务器状态和认证检查 |
| `/mcp/` | GET POST | MCP 服务器——将 AI 代理直接连接到你的知识库 |

完整的请求/响应详情请参阅[交互式文档](https://coddingtonbear.github.io/obsidian-local-rest-api/)。

## 精准修改笔记

`PATCH` 方法是此 API 最有用的功能之一。它允许你进行有针对性的编辑，而无需重写整个文件。

指定一个**目标**（标题、块引用或 frontmatter 键）和一个**操作**（`append` 追加、`prepend` 前置或 `replace` 替换），插件将精确应用更改：

```sh
# 替换 frontmatter 字段的值
curl -k -X PATCH \
  -H "Authorization: Bearer <你的API密钥>" \
  -H "Operation: replace" \
  -H "Target-Type: frontmatter" \
  -H "Target: status" \
  -H "Content-Type: application/json" \
  --data '"done"' \
  https://127.0.0.1:27124/vault/path/to/note.md
```

完整的请求头和选项列表请参阅[交互式文档](https://coddingtonbear.github.io/obsidian-local-rest-api/)。

## 定位特定部分

你可以在不获取或替换整个文件的情况下，读取或写入笔记的特定部分——标题、块引用或 frontmatter 字段。这适用于 GET、PUT、POST 和 PATCH 请求。

有两种指定目标的方式：

**请求头**——在任何请求中添加 `Target-Type` 和 `Target`：

```sh
# 读取指定标题下的内容
curl -k -H "Authorization: Bearer <你的API密钥>" \
  -H "Target-Type: heading" \
  -H "Target: My Section" \
  https://127.0.0.1:27124/vault/path/to/note.md

# 读取 frontmatter 字段
curl -k -H "Authorization: Bearer <你的API密钥>" \
  -H "Target-Type: frontmatter" \
  -H "Target: status" \
  https://127.0.0.1:27124/vault/path/to/note.md
```

**URL 路径段**（仅限 GET、PUT 和 POST）——在文件名后追加 `/<目标类型>/<目标>`：

```sh
# 读取指定标题
curl -k -H "Authorization: Bearer <你的API密钥>" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section

# 读取嵌套标题（层级用 :: 分隔）
curl -k -H "Authorization: Bearer <你的API密钥>" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/Work/Meetings

# 读取 frontmatter 字段
curl -k -H "Authorization: Bearer <你的API密钥>" \
  https://127.0.0.1:27124/vault/path/to/note.md/frontmatter/status

# 通过 PUT 替换标题内容
curl -k -X PUT \
  -H "Authorization: Bearer <你的API密钥>" \
  -H "Content-Type: text/plain" \
  --data "Updated content" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section

# 通过 POST 向标题追加内容
curl -k -X POST \
  -H "Authorization: Bearer <你的API密钥>" \
  -H "Content-Type: text/plain" \
  --data "Appended content" \
  https://127.0.0.1:27124/vault/path/to/note.md/heading/My%20Section
```

支持的目标类型：`heading`（标题）、`block`（块引用）、`frontmatter`。如果在同一个请求中同时提供 URL 嵌入目标和等效的请求头，将返回 `422 Unprocessable Entity`。

## 搜索

`POST /search/simple/?query=your+terms` 运行 Obsidian 内置的模糊搜索，返回匹配的文件名及带有分值的上下文片段。

`POST /search/` 接受 [JsonLogic](https://jsonlogic.com/) 表达式（内容类型 `application/vnd.olrapi.jsonlogic+json`），并针对每个笔记的元数据（frontmatter、标签、路径、内容）进行评估。

## MCP（模型上下文协议）

> [!NOTE]
> 虽然存在多个针对 Obsidian 的第三方 MCP 服务器，但它们已不再是必需——此插件内置了一个 MCP 服务器，运行在 Obsidian 内部，可以直接访问知识库的实时元数据、当前打开的文件、周期性笔记和命令面板。如果你正在使用第三方服务器，切换到本插件可能会获得更好的效果。

插件在 `/mcp/` 提供了一个内置的 MCP 服务器，使 AI 代理和 MCP 兼容客户端无需手动构造 HTTP 请求即可与你的知识库交互。

**传输协议：** Streamable HTTP——需要 API 密钥认证。

### 连接客户端

将你的 MCP 客户端连接到 `https://127.0.0.1:27124/mcp/`。认证使用 Bearer 令牌——在 **设置 → Local REST API** 中找到你的 API 密钥，然后以如下方式传递：

```
Authorization: Bearer <你的API密钥>
```

具体配置语法因客户端而异；请参阅上方[快速开始](#mcp-客户端)中的示例，或查阅客户端关于 Streamable HTTP 远程 MCP 服务器的文档。

> [!WARNING]
> 要安全地连接到 MCP 服务器，你的客户端必须信任插件的自签名证书。你可以从 `https://127.0.0.1:27124/obsidian-local-rest-api.crt` 下载并信任该证书，或者配置客户端跳过对 `127.0.0.1` 的 TLS 验证。
>
> 如果在你的环境中无法信任自签名证书，你可以使用 `http://127.0.0.1:27123/mcp/` 进行非安全连接，前提是在 **设置 → Local REST API → Enable HTTP server** 中启用了 HTTP 端点。

### 可用工具

| 工具 | 说明 |
|---|---|
| `vault_list` | 列出知识库目录内的文件和子目录 |
| `vault_read` | 读取文件的内容、frontmatter、标签和状态信息 |
| `vault_write` | 创建或覆盖知识库文件 |
| `vault_append` | 在知识库文件末尾追加内容 |
| `vault_patch` | 修改指定的标题、块引用或 frontmatter 字段 |
| `vault_delete` | 删除知识库文件 |
| `vault_move` | 将知识库文件移动（重命名）到新路径 |
| `vault_get_document_map` | 列出文件中的标题、块引用和 frontmatter 字段 |
| `active_file_get_path` | 返回 Obsidian 中当前打开文件的知识库路径 |
| `periodic_note_get_path` | 返回当前周期性笔记的知识库路径（`daily`、`weekly`、`monthly`、`quarterly`、`yearly`） |
| `search_query` | 使用 [JsonLogic](https://jsonlogic.com/) 查询笔记元数据进行搜索 |
| `search_simple` | 使用 Obsidian 内置搜索进行全文搜索 |
| `tag_list` | 列出知识库中所有标签及其使用次数 |
| `command_list` | 列出所有已注册的 Obsidian 命令 |
| `command_execute` | 按 ID 执行 Obsidian 命令 |
| `open_file` | 在 Obsidian UI 中打开文件 |

### 可用资源

| URI | 说明 |
|---|---|
| `obsidian://local-rest-api/openapi.yaml` | 此 REST API 的完整 OpenAPI 规范 |

## 多语言支持

此插件从版本 4.2.0 开始支持多语言界面。目前提供以下语言：

- **英语**（默认）
- **简体中文**

语言检测规则：

1. 插件启动时自动检测 Obsidian 的界面语言设置
2. 如果语言以 `zh` 开头（如 `zh-CN`、`zh-TW`、`zh-HK`），则显示中文
3. 其他语言环境默认显示英语

> **注意：** 当前多语言仅覆盖 **插件设置页面** 的显示文本。API 响应、错误消息和文档暂未国际化。

## 贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。如果你想在不修改核心代码的情况下添加功能，可以考虑构建一个 [API 扩展](https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Adding-your-own-API-Routes-via-an-Extension)——扩展可以独立开发和发布。

## 致谢

灵感来源于 [Vinzent03](https://github.com/Vinzent03) 的 [advanced-uri 插件](https://github.com/Vinzent03/obsidian-advanced-uri)，目标是突破自定义 URL scheme 的限制，扩展自动化操作的可能性。
