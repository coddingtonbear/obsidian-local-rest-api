/**
 * Lightweight i18n module for Obsidian Local REST API.
 *
 * English is the source of truth and is typed `as const`; every other locale
 * must cover exactly the same keys, which makes a typo or a missing entry a
 * compile error. Values are plain text: markup belongs to the caller and is
 * assembled with `renderTemplate` from `./i18nTemplate`.
 */

import { getLanguage } from "obsidian";

/* ------------------------------------------------------------------ */
/*  Key contract — en is the source of truth.                          */
/* ------------------------------------------------------------------ */

const en = {
  /* --- headings --- */
  "heading.title": "Local REST API with MCP",
  "heading.rest": "How to access via REST",
  "heading.mcp": "How to access via MCP",
  "heading.settings": "Settings",
  "heading.advanced": "Advanced settings",

  /* --- REST section --- */
  "rest.intro": "You can access the REST API via the following URLs:",
  "rest.secureName": "Encrypted (HTTPS) API URL",
  "rest.secureNote":
    "Requires that {link} be configured as a trusted certificate authority.  See {wikiLink} for more information.",
  "rest.insecureName": "Non-encrypted (HTTP) API URL",
  "rest.endpointUrl": "API URL",
  "rest.authHeader":
    "Your API key should be passed as a bearer token via the {header} header:",
  "rest.authLabel": "authorization header value",
  "rest.apiKeyHint": "Some tools ask for the API key on its own instead:",
  "rest.seeMore":
    "Comprehensive documentation of what API endpoints are available can be found in {docsLink}",
  "rest.serverStatus": "Server status",
  "rest.secureServerName": "Encrypted (HTTPS) server",
  "rest.insecureServerName": "Non-encrypted (HTTP) server",
  "rest.serverUrlCopyLabel": "server URL",
  "rest.disabledHintBelow": "You can enable this in the settings below.",
  "rest.disabledHintSubPage":
    "You can enable this from the plugin's settings page.",
  "rest.apiKeyDesc":
    'Passed as a bearer token via the {header} header; see the "How to access" pages below for details.',
  "rest.howToAccessDesc":
    "Connection URLs, authentication, and API documentation.",

  /* --- MCP section --- */
  "mcp.intro":
    "You can connect to the MCP server via the following endpoints:",
  "mcp.secureName": "Encrypted (HTTPS) MCP endpoint",
  "mcp.insecureName": "Non-encrypted (HTTP) MCP endpoint",
  "mcp.endpointUrl": "MCP endpoint URL",
  "mcp.disabledHint": "You can enable this from the plugin's settings page.",
  "mcp.authHeader":
    "Your API key should be passed as a bearer token via the {header} header:",
  "mcp.authLabel": "authorization header value",
  "mcp.apiKeyHint": "Some tools ask for the API key on its own instead:",
  "mcp.example":
    "Example Claude code MCP configuration (for .Claude/settings.json):",
  "mcp.seeMore":
    "Configuration examples for other MCP clients can be found in {docsLink}",
  "mcp.howToAccessDesc":
    "MCP endpoints, authentication, and client configuration examples.",

  /* --- common link labels --- */
  "link.certificate": "this certificate",
  "link.wiki": "wiki",
  "link.docs": "the online docs",
  "link.readme": "the project readme",

  /* --- copy feedback --- */
  "copy.tooltip": "Copy {label}",
  "copy.success": "Copied {label} to clipboard.",
  "copy.failure": "Could not copy {label} to the clipboard.",

  /* --- status --- */
  "status.disabled": "Disabled.  {hint}",
  "status.enabled": "Enabled",

  /* --- certificate warnings --- */
  "status.expired": "Your certificate has expired!",
  "status.expiredDesc":
    ' You must re-generate your certificate below by pressing the "Re-generate certificates" button below in order to connect securely to this API.',
  "status.expiringSoonOne": "Your certificate will expire in {days} day!",
  "status.expiringSoonOther": "Your certificate will expire in {days} days!",
  "status.expiringDesc":
    ' You should re-generate your certificate below by pressing the "Re-generate certificates" button below in order to continue to connect securely to this API.',
  "status.regenerate": "You should re-generate your certificate!",
  "status.regenerateDesc":
    ' Your certificate was generated using earlier standards than are currently used by Obsidian Local REST API with MCP. Some systems or tools may not accept your certificate with its current configuration, and re-generating your certificate may improve compatibility with such tools.  To re-generate your certificate, press the "Re-generate certificates" button below.',

  /* --- settings --- */
  "setting.insecureServer": "Enable non-encrypted (HTTP) server",
  "setting.insecureServerDesc":
    "Enables a non-encrypted (HTTP) server on the port designated below.  By default this plugin requires a secure HTTPS connection, but in safe environments you may turn on the non-encrypted server to simplify interacting with the API. Interactions with the API will still require the API key shown above.  Under no circumstances is it recommended that you expose this service to the internet, especially if you turn on this feature!",
  "setting.resetCrypto": "Reset all cryptography",
  "setting.resetCryptoDesc":
    "Regenerates your certificate, private key, public key, and API key. This settings panel will be closed when you confirm.",
  "setting.resetCryptoBtn": "Reset all crypto",
  "setting.regenerateCert": "Re-generate certificates",
  "setting.regenerateCertDesc":
    "Regenerates your certificate authority, server certificate, and their keys; your API key remains unchanged. Anything that trusted the previous certificate will need to trust the new one. This settings panel will be closed when you press this.",
  "setting.regenerateCertBtn": "Re-generate certificates",
  "setting.restoreDefaults": "Restore default settings",
  "setting.restoreDefaultsDesc":
    "Resets this plugin's settings to defaults. This settings panel will be closed when you confirm.",
  "setting.restoreDefaultsBtn": "Restore defaults",
  "setting.advancedSettingsHeading": "Advanced settings",
  "setting.advancedSettingsDesc":
    "Advanced settings are dangerous and may make your environment less secure.",
  "setting.enableSecureServer": "Enable encrypted (HTTPS) server",
  "setting.enableSecureServerDesc":
    "This controls whether the HTTPS server is enabled.  You almost certainly want to leave this switch in its default state ('on'), but may find it useful to turn this switch off for troubleshooting.",
  "setting.securePort": "Encrypted (HTTPS) server port",
  "setting.securePortDesc":
    "This configures the port on which your REST API will listen for HTTPS connections.  It is recommended that you leave this port with its default setting as tools integrating with this API may expect the default port to be in use.  Under no circumstances is it recommended that you expose this service directly to the internet.",
  "setting.insecurePort": "Non-encrypted (HTTP) server port",
  "setting.apiKey": "API key",
  "setting.certificateHostnames": "Certificate hostnames",
  "setting.certificateHostnamesDesc":
    'List of extra hostnames to add to your certificate\'s `subjectAltName` field. One hostname per line. You must click the "Re-generate certificates" button above after changing this value for this to have an effect: the certificate authority only permits the hostnames it was generated with, so the server certificate cannot be renewed for new ones.  This is useful for situations in which you are accessing Obsidian from a hostname other than the host on which it is running.',
  "setting.authorizationHeader": "Authorization header",
  "setting.bindingHost": "Binding host",
  "setting.verboseLogging": "Enable verbose logging",
  "setting.verboseLoggingDesc":
    "When enabled, logs server startup messages and a one-line access log entry for every request to the browser console.",

  /* --- settings added after the settings page was rewritten --- */
  "setting.enableSignedUrls": "Enable signed URLs",
  "setting.enableSignedUrlsDesc":
    "Lets the MCP tools hand out expiring links to individual vault files (vault_get_download_url, vault_get_upload_url, and vault_read_binary's link mode) that work without the API key, so a browser or a shell can fetch or upload a file directly. Anyone holding such a link can read (or, for an upload link, write once to) that one file until it expires. The signing secret is regenerated every time the plugin loads, so links never outlive a restart.",
  "setting.signedUrlTtl": "Signed URL lifetime (seconds)",
  "setting.signedUrlTtlDesc":
    "How long a signed URL stays valid. Between {min} and {max} seconds; the default is {default}.",
  "setting.stateReadTimeout": "Extension state read budget (milliseconds)",
  "setting.stateReadTimeoutDesc":
    "How long GET / waits for an extension plugin to report its state before serving null for that plugin. Extensions are read concurrently, so this bounds the whole wait. Between {min} and {max} milliseconds; the default is {default}.",
  "setting.configDirAccess": "Allow access to the configuration directory",
  "setting.configDirAccessDesc":
    "When off (the default), the API refuses to read or write any file inside Obsidian's configuration directory (currently '{configDir}'). That directory holds plugin code and each plugin's data.json — including this plugin's own, where your API key lives — so writing there is effectively arbitrary code execution and reading there leaks secrets. Leave this off unless you specifically need to manage your Obsidian configuration through the API, and understand that turning it on grants every holder of your API key that power.",

  /* --- certificate display & update --- */
  "cert.status": "Certificate status",
  "cert.expired": "Expired",
  "cert.expiresInOne": "Expires in {days} day",
  "cert.expiresInOther": "Expires in {days} days",
  "cert.shouldRegenerate": "Should be regenerated",
  "cert.updateAvailable": "Update available",
  "cert.valid": "Valid",
  "cert.caUpdate":
    'Certificate generation has been updated to support the stricter verification performed by recent versions of some browsers and tools (Firefox, for example). Your current certificate will keep working everywhere it works today. If you find that a browser or tool rejects it, press "Re-generate certificates" below, then re-import the newly generated certificate wherever you had trusted the old one.',

  /* --- settings page sections --- */
  "setting.certificates": "Certificates",
  "setting.certificatesDesc":
    "Regenerate certificates and edit certificate hostnames, key material, and the API key.",

  /* --- modal dialogs --- */
  "modal.resetTitle": "Reset all cryptography?",
  "modal.resetMessage":
    "This regenerates your certificate, private key, public key, and API key, and closes this settings panel. This cannot be undone.",
  "modal.restoreTitle": "Restore default settings?",
  "modal.restoreMessage":
    "This resets this plugin\u2019s settings to defaults and closes this settings panel. This cannot be undone.",

  /* --- advanced page --- */
  "advanced.license": "License",
  "advanced.caCert": "CA certificate",
  "advanced.caCertDesc":
    "The certificate authority that signed the server certificate; this is what clients download and trust. Leave empty if your server certificate is self-signed.",
  "advanced.caPrivateKey": "CA private key",
  "advanced.caPrivateKeyDesc":
    "Used to renew the server certificate automatically before it expires. Leave empty to disable automatic renewal.",
  "advanced.serverCert": "Server certificate",
  "advanced.serverCertDesc":
    "The certificate presented by the HTTPS server.",
  "advanced.serverPublicKey": "Server public key",
  "advanced.serverPrivateKey": "Server private key",

  /* --- advanced static text --- */
  "advanced.warning":
    "The settings below are potentially dangerous and are intended for use only by people who know what they are doing. Do not change any of these settings if you do not understand what that setting is used for and what security impacts changing that setting will have.",
  "advanced.noWarranty":
    "Use of this software is licensed to you under the MIT license, and it is important that you understand that this license provides you with no warranty. For the complete license text please see {licenseLink}.",
} as const;

/* ------------------------------------------------------------------ */
/*  Compile-time key parity                                            */
/* ------------------------------------------------------------------ */

/** Every valid translation key — derived from the English dictionary. */
export type MessageKey = keyof typeof en;

/** A translation map must have exactly the same keys as English. */
type StrMap = Record<MessageKey, string>;

/** Every key, in dictionary order; used by the parity tests. */
export const messageKeys = Object.keys(en) as MessageKey[];

/* ------------------------------------------------------------------ */
/*  Chinese (Simplified)                                               */
/* ------------------------------------------------------------------ */

const zh: StrMap = {
  /* --- headings --- */
  "heading.title": "本地 REST API（含 MCP）",
  "heading.rest": "如何通过 REST 访问",
  "heading.mcp": "如何通过 MCP 访问",
  "heading.settings": "设置",
  "heading.advanced": "高级设置",

  /* --- REST section --- */
  "rest.intro": "您可以通过以下 URL 访问 REST API：",
  "rest.secureName": "加密（HTTPS）API 地址",
  "rest.secureNote":
    "需要将 {link} 配置为受信任的证书颁发机构。请参阅 {wikiLink} 了解更多信息。",
  "rest.insecureName": "非加密（HTTP）API 地址",
  "rest.endpointUrl": "API 地址",
  "rest.authHeader": "您的 API 密钥应通过 {header} 标头以 Bearer 令牌形式传递：",
  "rest.authLabel": "授权标头值",
  "rest.apiKeyHint": "某些工具需要单独的 API 密钥：",
  "rest.seeMore": "有关可用 API 端点的完整文档，请参阅 {docsLink}",
  "rest.serverStatus": "服务器状态",
  "rest.secureServerName": "加密（HTTPS）服务器",
  "rest.insecureServerName": "非加密（HTTP）服务器",
  "rest.serverUrlCopyLabel": "服务器 URL",
  "rest.disabledHintBelow": "您可以在下方的设置中启用。",
  "rest.disabledHintSubPage": "您可以在插件设置页面中启用此项。",
  "rest.apiKeyDesc":
    "通过 {header} 标头以 Bearer 令牌形式传递；详情请参阅下方的「如何访问」页面。",
  "rest.howToAccessDesc": "连接 URL、身份验证和 API 文档。",

  /* --- MCP section --- */
  "mcp.intro": "您可以通过以下端点连接到 MCP 服务器：",
  "mcp.secureName": "加密（HTTPS）MCP 端点",
  "mcp.insecureName": "非加密（HTTP）MCP 端点",
  "mcp.endpointUrl": "MCP 端点地址",
  "mcp.disabledHint": "您可以在插件设置页面中启用此项。",
  "mcp.authHeader": "您的 API 密钥应通过 {header} 标头以 Bearer 令牌形式传递：",
  "mcp.authLabel": "授权标头值",
  "mcp.apiKeyHint": "某些工具需要单独的 API 密钥：",
  "mcp.example": "Claude Code MCP 配置示例（用于 .Claude/settings.json）：",
  "mcp.seeMore": "其他 MCP 客户端的配置示例，请参阅 {docsLink}",
  "mcp.howToAccessDesc": "MCP 端点、身份验证和客户端配置示例。",

  /* --- common link labels --- */
  "link.certificate": "此证书",
  "link.wiki": "维基页面",
  "link.docs": "在线文档",
  "link.readme": "项目说明",

  /* --- copy feedback --- */
  "copy.tooltip": "复制{label}",
  "copy.success": "已将{label}复制到剪贴板。",
  "copy.failure": "无法将{label}复制到剪贴板。",

  /* --- status --- */
  "status.disabled": "已禁用。 {hint}",
  "status.enabled": "已启用",

  /* --- certificate warnings --- */
  "status.expired": "您的证书已过期！",
  "status.expiredDesc":
    "您必须点击下方「重新生成证书」按钮来重新生成证书，才能安全地连接到此 API。",
  "status.expiringSoonOne": "您的证书将在 {days} 天后过期！",
  "status.expiringSoonOther": "您的证书将在 {days} 天后过期！",
  "status.expiringDesc":
    "您应当点击下方「重新生成证书」按钮来重新生成证书，以继续安全地连接到此 API。",
  "status.regenerate": "建议您重新生成证书！",
  "status.regenerateDesc":
    "您的证书使用的标准低于 Obsidian 本地 REST API（含 MCP）当前使用的标准。某些系统或工具可能无法接受当前配置的证书，重新生成证书可提高与这些工具的兼容性。要重新生成证书，请点击下方的「重新生成证书」按钮。",

  /* --- settings --- */
  "setting.insecureServer": "启用非加密（HTTP）服务器",
  "setting.insecureServerDesc":
    "在下方指定的端口上启用非加密（HTTP）服务器。默认情况下，此插件要求安全的 HTTPS 连接，但在安全环境中，您可以启用非加密服务器以简化与 API 的交互。与 API 的交互仍需使用上方显示的 API 密钥。在任何情况下都不建议将此服务暴露到互联网，特别是在启用此功能时！",
  "setting.resetCrypto": "重置所有加密信息",
  "setting.resetCryptoDesc":
    "将重新生成您的证书、私钥、公钥和 API 密钥。确认后此设置面板将关闭。",
  "setting.resetCryptoBtn": "重置所有加密",
  "setting.regenerateCert": "重新生成证书",
  "setting.regenerateCertDesc":
    "将重新生成您的证书颁发机构、服务器证书及其密钥；您的 API 密钥保持不变。任何信任旧证书的对象都需要信任新证书。点击后此设置面板将关闭。",
  "setting.regenerateCertBtn": "重新生成证书",
  "setting.restoreDefaults": "恢复默认设置",
  "setting.restoreDefaultsDesc":
    "将此插件的设置重置为默认值。确认后此设置面板将关闭。",
  "setting.restoreDefaultsBtn": "恢复默认",
  "setting.advancedSettingsHeading": "高级设置",
  "setting.advancedSettingsDesc":
    "高级设置可能带来安全风险，可能降低您的环境安全性。",
  "setting.enableSecureServer": "启用加密（HTTPS）服务器",
  "setting.enableSecureServerDesc":
    "控制是否启用 HTTPS 服务器。您几乎肯定希望保持此开关的默认状态（「开」），但在排查问题时可能希望将其关闭。",
  "setting.securePort": "加密（HTTPS）服务器端口",
  "setting.securePortDesc":
    "配置 REST API 监听 HTTPS 连接的端口。建议保留默认端口，因为与此 API 集成的工具可能期望使用默认端口。在任何情况下都不建议将此服务直接暴露到互联网。",
  "setting.insecurePort": "非加密（HTTP）服务器端口",
  "setting.apiKey": "API 密钥",
  "setting.certificateHostnames": "证书主机名",
  "setting.certificateHostnamesDesc":
    "要添加到证书 `subjectAltName` 字段的额外主机名列表，每行一个主机名。更改此值后，必须点击上方的「重新生成证书」按钮才能生效：证书颁发机构只允许使用生成时指定的主机名，因此无法为新主机名续期服务器证书。当您需要从运行 Obsidian 之外的主机名访问时，此设置非常有用。",
  "setting.authorizationHeader": "授权标头",
  "setting.bindingHost": "绑定主机",
  "setting.verboseLogging": "启用详细日志",
  "setting.verboseLoggingDesc":
    "启用后，将在浏览器控制台中记录服务器启动消息和每个请求的单行访问日志。",

  /* --- settings added after the settings page was rewritten --- */
  "setting.enableSignedUrls": "启用签名 URL",
  "setting.enableSignedUrlsDesc":
    "允许 MCP 工具签发指向单个 vault 文件的短期链接（vault_get_download_url、vault_get_upload_url 以及 vault_read_binary 的链接模式），无需 API 密钥即可使用，从而让浏览器或 shell 直接读取或上传文件。任何持有此类链接的人都能在该链接过期前读取（对于上传链接，则是写入一次）那一个文件。签名密钥在每次插件加载时重新生成，因此链接不会在重启后继续有效。",
  "setting.signedUrlTtl": "签名 URL 有效期（秒）",
  "setting.signedUrlTtlDesc":
    "签名 URL 的有效时长。介于 {min} 和 {max} 秒之间；默认值为 {default}。",
  "setting.stateReadTimeout": "扩展状态读取预算（毫秒）",
  "setting.stateReadTimeoutDesc":
    "GET / 在返回该插件的 null 状态前，等待扩展插件上报状态的最长时间。扩展是并发读取的，因此该值约束的是整体等待时间。介于 {min} 和 {max} 毫秒之间；默认值为 {default}。",
  "setting.configDirAccess": "允许访问配置目录",
  "setting.configDirAccessDesc":
    "关闭时（默认），API 拒绝读取或写入 Obsidian 配置目录（当前为 '{configDir}'）中的任何文件。该目录存放插件代码和每个插件的 data.json——包括本插件存放 API 密钥的文件——因此写入该目录实际上等同于任意代码执行，读取则会泄露密钥。除非您确实需要通过 API 管理 Obsidian 配置，否则请保持关闭，并理解开启后每位持有您 API 密钥的人都将获得该权限。",

  /* --- certificate display & update --- */
  "cert.status": "证书状态",
  "cert.expired": "已过期",
  "cert.expiresInOne": "将在 {days} 天后过期",
  "cert.expiresInOther": "将在 {days} 天后过期",
  "cert.shouldRegenerate": "建议重新生成",
  "cert.updateAvailable": "有可用更新",
  "cert.valid": "有效",
  "cert.caUpdate":
    "证书生成已更新，支持某些浏览器和工具（例如 Firefox）最近版本执行的更严格验证。您当前的证书在目前已支持的所有地方仍可正常使用。如果发现浏览器或工具拒绝该证书，请点击下方的「重新生成证书」，然后在之前信任旧证书的地方重新导入新生成的证书。",

  /* --- settings page sections --- */
  "setting.certificates": "证书",
  "setting.certificatesDesc": "重新生成证书，编辑证书主机名、密钥材料和 API 密钥。",

  /* --- modal dialogs --- */
  "modal.resetTitle": "重置所有加密信息？",
  "modal.resetMessage":
    "此操作将重新生成您的证书、私钥、公钥和 API 密钥，并关闭此设置面板。此操作不可撤销。",
  "modal.restoreTitle": "恢复默认设置？",
  "modal.restoreMessage":
    "此操作将重置此插件的设置为默认值，并关闭此设置面板。此操作不可撤销。",

  /* --- advanced page --- */
  "advanced.license": "许可证",
  "advanced.caCert": "CA 证书",
  "advanced.caCertDesc":
    "签署服务器证书的证书颁发机构；客户端会下载并信任此证书。如果您的服务器证书是自签名的，请留空。",
  "advanced.caPrivateKey": "CA 私钥",
  "advanced.caPrivateKeyDesc":
    "用于在证书到期前自动续期服务器证书。留空以禁用自动续期。",
  "advanced.serverCert": "服务器证书",
  "advanced.serverCertDesc": "HTTPS 服务器呈现的证书。",
  "advanced.serverPublicKey": "服务器公钥",
  "advanced.serverPrivateKey": "服务器私钥",

  /* --- advanced static text --- */
  "advanced.warning":
    "以下设置可能存在安全风险，仅供了解其作用的人使用。如果您不了解某项设置的用途及其安全影响，请不要更改它。",
  "advanced.noWarranty":
    "本软件的使用根据 MIT 许可证授权给您，请务必理解该许可证不提供任何担保。完整的许可证文本请参阅 {licenseLink}。",
};

/* ------------------------------------------------------------------ */
/*  Language detection & t() function                                  */
/* ------------------------------------------------------------------ */

function detectLanguage(): "en" | "zh" {
  // Obsidian reports a regional tag (zh-CN, zh-TW, ...). Traditional Chinese
  // readers get the Simplified strings rather than English: a deliberate
  // fallback until a zh-TW locale exists.
  const lang = getLanguage();
  return lang.startsWith("zh") ? "zh" : "en";
}

let currentLang: "en" | "zh" = detectLanguage();
const locales: Record<"en" | "zh", StrMap> = { en, zh };

/**
 * Translate a key, replacing every `{name}` placeholder in the string.
 *
 * Values are inserted as plain text. A placeholder that needs markup (a link,
 * inline code) belongs in `renderTemplate` from `./i18nTemplate`, not in a
 * translated string.
 */
export function t(
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const map = locales[currentLang];
  let str = (map && map[key]) ?? locales["en"]?.[key] ?? key;

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

/** Base keys that have `…One` / `…Other` variants. */
export type PluralBase = "cert.expiresIn" | "status.expiringSoon";

/**
 * Translate a count-dependent string.
 *
 * `Intl.PluralRules` decides which form the active language needs: English
 * switches at 1, Chinese has a single form for every count, so the call site
 * no longer has to know. The template interpolates the count as `{days}`.
 */
export function tPlural(base: PluralBase, count: number): string {
  const category = new Intl.PluralRules(currentLang).select(count);
  const suffix = category === "one" ? "One" : "Other";
  return t(`${base}${suffix}` as MessageKey, { days: count });
}

/**
 * Override the current language (useful for testing).
 */
export function setLanguage(lang: string): void {
  if (lang === "en" || lang === "zh") currentLang = lang;
}

/**
 * Force re-detection from Obsidian's configured interface language.
 */
export function resetLanguage(): void {
  currentLang = detectLanguage();
}

/**
 * Return the currently active language code.
 */
export function getCurrentLanguage(): "en" | "zh" {
  return currentLang;
}
