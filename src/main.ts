import {
  App,
  ConfirmationModal,
  ExtraButtonComponent,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
} from "obsidian";
import * as https from "https";
import * as http from "http";
import forge from "node-forge";

import RequestHandler from "./requestHandler";
import { LocalRestApiSettings } from "./types";

import {
  DefaultBearerTokenHeaderName,
  CERT_NAME,
  DEFAULT_SETTINGS,
  DefaultBindingHost,
  LicenseUrl,
} from "./constants";
import {
  CertificateStandardsIssue,
  buildServerCertificateChain,
  generateCryptoSettings,
  getCertificateStandardsIssue,
  getCertificateValidityDays,
  renewServerCertificateIfNeeded,
} from "./certificates";
import type { LocalRestApiPublicApi } from "./publicApi";
// The extension API is defined in ./publicApi, which is what the generated
// publicApi.d.ts ships to extension authors. Re-exported here so that anything
// importing the plugin entry point keeps seeing the same names it always has.
export {
  ApiVersionUnsupportedError,
  getAPI,
  type McpToolAnnotations,
  type LocalRestApiPublicApi,
} from "./publicApi";
import { PluginManifest } from "obsidian";
import { configureHttpServerTimeouts } from "./serverTimeouts";

export default class LocalRestApi extends Plugin {
  declare settings: LocalRestApiSettings;
  secureServer: https.Server | null = null;
  insecureServer: http.Server | null = null;
  requestHandler: RequestHandler;
  refreshServerState: () => void;

  async onload() {
    this.refreshServerState = this.debounce(
      this._refreshServerState.bind(this),
      1000
    );

    await this.loadSettings();

    this.requestHandler = new RequestHandler(
      this.app,
      this.manifest,
      this.settings
    );
    this.requestHandler.setupRouter();

    if (!this.settings.apiKey) {
      this.settings.apiKey = forge.md.sha256
        .create()
        .update(forge.random.getBytesSync(128))
        .digest()
        .toHex();
      await this.saveSettings();
    }
    if (!this.settings.crypto) {
      this.settings.crypto = generateCryptoSettings({
        bindingHost: this.settings.bindingHost,
        subjectAltNames: this.settings.subjectAltNames,
      });
      await this.saveSettings();
    } else {
      // Material generated with a CA can have its server certificate renewed
      // quietly; the CA users have trusted stays the same. Legacy single
      // self-signed certificates are left alone (see renderCertificateWarnings).
      const renewed = renewServerCertificateIfNeeded(this.settings.crypto, {
        bindingHost: this.settings.bindingHost,
        subjectAltNames: this.settings.subjectAltNames,
      });
      if (renewed) {
        this.settings.crypto = renewed;
        await this.saveSettings();
        if (this.settings.enableVerboseLogging) {
          console.debug("[REST API] Renewed the server certificate from the stored CA");
        }
      }
    }

    this.addSettingTab(new LocalRestApiSettingTab(this.app, this));

    this.refreshServerState();

    this.app.workspace.trigger("obsidian-local-rest-api:loaded");
  }

  getPublicApi(pluginManifest: PluginManifest): LocalRestApiPublicApi {
    if (!pluginManifest.id || !pluginManifest.name || !pluginManifest.version) {
      throw new Error(
        "PluginManifest instance must include a defined id, name, and version to be accempted."
      );
    }

    if (this.settings.enableVerboseLogging) {
      console.debug("[REST API] Added new API extension", pluginManifest);
    }

    return this.requestHandler.registerApiExtension(pluginManifest);
  }

  debounce<F extends (...args: unknown[]) => unknown>(
    func: F,
    delay: number
  ): (...args: Parameters<F>) => void {
    let debounceTimer: number;
    return (...args: Parameters<F>): void => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => func(...args), delay);
    };
  }

  _refreshServerState() {
    if (this.secureServer) {
      this.secureServer.closeAllConnections();
      this.secureServer.close();
      this.secureServer = null;
    }
    if ((this.settings.enableSecureServer ?? true) && this.settings.crypto) {
      this.secureServer = https.createServer(
        {
          key: this.settings.crypto.privateKey,
          cert: buildServerCertificateChain(this.settings.crypto),
        },
        this.requestHandler.api
      );
      configureHttpServerTimeouts(this.secureServer);
      this.secureServer.listen(
        this.settings.port,
        this.settings.bindingHost ?? DefaultBindingHost
      );

      if (this.settings.enableVerboseLogging) {
        console.debug(
          `[REST API] Listening on https://${
            this.settings.bindingHost ?? DefaultBindingHost
          }:${this.settings.port}/`
        );
      }
    }

    if (this.insecureServer) {
      this.insecureServer.closeAllConnections();
      this.insecureServer.close();
      this.insecureServer = null;
    }
    if (this.settings.enableInsecureServer) {
      this.insecureServer = http.createServer(this.requestHandler.api);
      configureHttpServerTimeouts(this.insecureServer);
      this.insecureServer.listen(
        this.settings.insecurePort,
        this.settings.bindingHost ?? DefaultBindingHost
      );

      if (this.settings.enableVerboseLogging) {
        console.debug(
          `[REST API] Listening on http://${
            this.settings.bindingHost ?? DefaultBindingHost
          }:${this.settings.insecurePort}/`
        );
      }
    }
  }

  onunload() {
    this.requestHandler?.mcpHandler.close();
    if (this.secureServer) {
      this.secureServer.closeAllConnections();
      this.secureServer.close();
    }
    if (this.insecureServer) {
      this.insecureServer.closeAllConnections();
      this.insecureServer.close();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<LocalRestApiSettings>);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class LocalRestApiSettingTab extends PluginSettingTab {
  plugin: LocalRestApi;

  constructor(app: App, plugin: LocalRestApi) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Summarises the stored certificate material for the settings UI.
   *
   * With CA-backed material the server certificate renews itself on load, so
   * the expiry that matters to the user is the CA's: that is what they
   * imported, and what they will have to import again. Legacy material has
   * only the one certificate, so its expiry is reported directly.
   */
  private getCertificateStatus(): {
    remainingCertificateValidityDays: number | null;
    standardsIssue: CertificateStandardsIssue | null;
  } {
    const crypto = this.plugin.settings.crypto;
    if (!crypto) {
      return { remainingCertificateValidityDays: null, standardsIssue: null };
    }
    try {
      const served = forge.pki.certificateFromPem(crypto.cert);
      const trusted = crypto.caCert
        ? forge.pki.certificateFromPem(crypto.caCert)
        : served;
      return {
        remainingCertificateValidityDays: getCertificateValidityDays(trusted),
        standardsIssue: getCertificateStandardsIssue(served),
      };
    } catch {
      return { remainingCertificateValidityDays: null, standardsIssue: null };
    }
  }

  /**
   * Renders a value in a `pre` block with a button that copies it.
   *
   * These blocks are styled `user-select: all`, so a single click already
   * selects the whole value -- but nothing about them says so. The button is
   * the discoverable version of that affordance.
   *
   * `label` names the value in the tooltip and in the confirmation notice, so
   * it reads as a lowercase noun phrase ("API key", not "Copy API Key").
   */
  private renderCopyableValue(
    el: HTMLElement,
    value: string,
    label: string,
    cls = "copyable-value"
  ): void {
    const wrapper = el.createDiv({ cls });
    wrapper.createEl("pre", { text: value });
    new ExtraButtonComponent(wrapper)
      .setIcon("copy")
      .setTooltip(`Copy ${label}`)
      .onClick(() => {
        void this.copyToClipboard(value, label);
      });
  }

  private async copyToClipboard(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      new Notice(`Copied ${label} to clipboard.`);
    } catch {
      // writeText rejects when the document is not focused or the platform
      // refuses permission. The notice is this button's only feedback, so
      // swallowing the rejection would make a failed copy indistinguishable
      // from a successful one.
      new Notice(`Could not copy ${label} to the clipboard.`);
    }
  }

  /**
   * Returns the extra hostnames configured for the certificate, one URL table
   * row (and certificate `subjectAltName`) per non-blank line.
   */
  private getSubjectAltNames(): string[] {
    return (this.plugin.settings.subjectAltNames ?? "")
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  }

  /**
   * Renders the two-row (HTTPS/HTTP) URL table used by the main settings page
   * and both "How to access" pages. Each URL gets the copy-button treatment.
   *
   * `pathSuffix` is appended to every URL (`/` for the API root, `/mcp/` for
   * the MCP endpoint). `disabledHint` tells the reader where the enable
   * switches live, which differs between the main page ("below") and the
   * sub-pages (back on the main page). The certificate note is instructional,
   * so the main page's status table leaves it off.
   */
  private renderServerUrlTable(
    el: HTMLElement,
    options: {
      pathSuffix: string;
      secureName: string;
      insecureName: string;
      copyLabel: string;
      includeCertificateNote: boolean;
      disabledHint: string;
    }
  ): void {
    const settings = this.plugin.settings;
    const altNames = this.getSubjectAltNames();
    const table = el.createEl("table", { cls: "api-urls" });
    const tbody = table.createEl("tbody");

    const addRow = (row: {
      enabled: boolean;
      name: string;
      urls: string[];
      note?: (noteEl: HTMLElement) => void;
    }) => {
      const tr = tbody.createEl(
        "tr",
        row.enabled
          ? { title: "Enabled" }
          : { cls: "disabled", title: `Disabled.  ${options.disabledHint}` }
      );
      tr.createEl("td", { text: row.enabled ? "✅" : "❌" });
      const nameTd = tr.createEl("td", { cls: "name" });
      nameTd.createSpan({ text: row.name });
      if (row.note) {
        nameTd.createEl("br");
        nameTd.createEl("br");
        row.note(nameTd.createEl("i"));
      }
      const urlTd = tr.createEl("td", { cls: "url" });
      for (const url of row.urls) {
        this.renderCopyableValue(urlTd, url, options.copyLabel);
      }
    };

    addRow({
      enabled: settings.enableSecureServer !== false,
      name: options.secureName,
      urls: [
        `https://127.0.0.1:${settings.port}${options.pathSuffix}`,
        ...altNames.map(
          (name) => `https://${name}:${settings.port}${options.pathSuffix}`
        ),
      ],
      note: options.includeCertificateNote
        ? (noteEl) => {
            noteEl.createSpan({ text: "Requires that " });
            noteEl.createEl("a", {
              href: `https://127.0.0.1:${settings.port}/${CERT_NAME}`,
              text: "this certificate",
            });
            noteEl.createSpan({
              text: " be configured as a trusted certificate authority.  See ",
            });
            noteEl.createEl("a", {
              href: "https://github.com/coddingtonbear/obsidian-web/wiki/How-do-I-get-my-browser-trust-my-Obsidian-Local-REST-API-certificate%3F",
              text: "wiki",
            });
            noteEl.createSpan({ text: " for more information." });
          }
        : undefined,
    });

    addRow({
      enabled: settings.enableInsecureServer !== false,
      name: options.insecureName,
      urls: [
        `http://127.0.0.1:${settings.insecurePort}${options.pathSuffix}`,
        ...altNames.map(
          (name) => `http://${name}:${settings.insecurePort}${options.pathSuffix}`
        ),
      ],
    });
  }

  private renderConnectionInfo(el: HTMLElement): void {
    const apiKeyDiv = el.createDiv();
    apiKeyDiv.classList.add("api-key-display");

    apiKeyDiv.createEl("p", {
      text: "You can access the REST API via the following URLs:",
    });

    this.renderServerUrlTable(apiKeyDiv, {
      pathSuffix: "/",
      secureName: "Encrypted (HTTPS) API URL",
      insecureName: "Non-encrypted (HTTP) API URL",
      copyLabel: "API URL",
      includeCertificateNote: true,
      disabledHint: "You can enable this from the plugin's settings page.",
    });

    const authHeaderP = apiKeyDiv.createEl("p");
    authHeaderP.createSpan({
      text: "Your API key should be passed as a bearer token via the ",
    });
    authHeaderP.createEl("code", {
      text:
        this.plugin.settings.authorizationHeaderName ??
        DefaultBearerTokenHeaderName,
    });
    authHeaderP.createSpan({ text: " header:" });

    this.renderCopyableValue(
      apiKeyDiv,
      `Bearer ${this.plugin.settings.apiKey}`,
      "authorization header value"
    );

    apiKeyDiv.createEl("p", {
      text: "Some tools ask for the API key on its own instead:",
    });
    this.renderCopyableValue(
      apiKeyDiv,
      this.plugin.settings.apiKey ?? "",
      "API key"
    );

    const seeMore = apiKeyDiv.createEl("p");
    seeMore.createSpan({
      text: "Comprehensive documentation of what API endpoints are available can be found in ",
    });
    seeMore.createEl("a", {
      href: "https://coddingtonbear.github.io/obsidian-local-rest-api/",
      text: "the online docs",
    });
    seeMore.createSpan({ text: "." });
  }

  private renderMcpInfo(el: HTMLElement): void {
    const mcpDiv = el.createDiv();
    mcpDiv.classList.add("mcp-display");

    mcpDiv.createEl("p", {
      text: "You can connect to the MCP server via the following endpoints:",
    });

    this.renderServerUrlTable(mcpDiv, {
      pathSuffix: "/mcp/",
      secureName: "Encrypted (HTTPS) MCP endpoint",
      insecureName: "Non-encrypted (HTTP) MCP endpoint",
      copyLabel: "MCP endpoint URL",
      includeCertificateNote: true,
      disabledHint: "You can enable this from the plugin's settings page.",
    });

    const mcpSecureUrl = `https://127.0.0.1:${this.plugin.settings.port}/mcp/`;

    const headerName =
      this.plugin.settings.authorizationHeaderName ??
      DefaultBearerTokenHeaderName;

    const mcpAuthHeaderP = mcpDiv.createEl("p");
    mcpAuthHeaderP.createSpan({
      text: "Your API key should be passed as a bearer token via the ",
    });
    mcpAuthHeaderP.createEl("code", { text: headerName });
    mcpAuthHeaderP.createSpan({ text: " header:" });

    this.renderCopyableValue(
      mcpDiv,
      `Bearer ${this.plugin.settings.apiKey}`,
      "authorization header value"
    );

    mcpDiv.createEl("p", {
      text: "Some tools ask for the API key on its own instead:",
    });
    this.renderCopyableValue(
      mcpDiv,
      this.plugin.settings.apiKey ?? "",
      "API key"
    );

    const mcpSampleConfig = JSON.stringify(
      {
        mcpServers: {
          obsidian: {
            type: "http",
            url: mcpSecureUrl,
            headers: {
              [headerName]: `Bearer ${this.plugin.settings.apiKey}`,
            },
          },
        },
      },
      null,
      2
    );

    mcpDiv.createEl("p", {
      text: "Example Claude code MCP configuration (for .Claude/settings.json):",
    });
    mcpDiv.createEl("pre", { text: mcpSampleConfig });

    const mcpSeeMore = mcpDiv.createEl("p");
    mcpSeeMore.createSpan({
      text: "Configuration examples for other MCP clients can be found in ",
    });
    mcpSeeMore.createEl("a", {
      href: "https://github.com/coddingtonbear/obsidian-local-rest-api#readme",
      text: "the project readme",
    });
    mcpSeeMore.createSpan({ text: "." });
  }

  private renderCertificateWarnings(el: HTMLElement): void {
    const { remainingCertificateValidityDays, standardsIssue } =
      this.getCertificateStatus();

    if (remainingCertificateValidityDays !== null && remainingCertificateValidityDays < 0) {
      const expiredCertDiv = el.createDiv();
      expiredCertDiv.classList.add("certificate-expired");
      expiredCertDiv.createEl("b", { text: "Your certificate has expired!" });
      expiredCertDiv.createSpan({
        text: ' You must re-generate your certificate below by pressing the "Re-generate certificates" button below in order to connect securely to this API.',
      });
    } else if (remainingCertificateValidityDays !== null && remainingCertificateValidityDays < 30) {
      const soonExpiringCertDiv = el.createDiv();
      soonExpiringCertDiv.classList.add("certificate-expiring-soon");
      const daysRemaining = Math.floor(remainingCertificateValidityDays);
      soonExpiringCertDiv.createEl("b", {
        text: `Your certificate will expire in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}!`,
      });
      soonExpiringCertDiv.createSpan({
        text: ' You should re-generate your certificate below by pressing the "Re-generate certificates" button below in order to continue to connect securely to this API.',
      });
    }
    if (standardsIssue === "legacy-ipv4-san") {
      const shouldRegenerateCertificateDiv = el.createDiv();
      shouldRegenerateCertificateDiv.classList.add(
        "certificate-regeneration-recommended"
      );
      shouldRegenerateCertificateDiv.createEl("b", {
        text: "You should re-generate your certificate!",
      });
      shouldRegenerateCertificateDiv.createSpan({
        text: " Your certificate was generated using earlier standards than are currently used by Obsidian Local REST API with MCP. Some systems or tools may not accept your certificate with its current configuration, and re-generating your certificate may improve compatibility with such tools.  To re-generate your certificate, press the \"Re-generate certificates\" button below.",
      });
    } else if (standardsIssue === "ca-used-as-leaf") {
      // Deliberately mild: nothing is broken for anyone this certificate
      // already works for, and regenerating costs them a re-import.
      const updateAvailableDiv = el.createDiv();
      updateAvailableDiv.classList.add("certificate-update-available");
      updateAvailableDiv.createSpan({
        text: "Certificate generation has been updated to support the stricter verification performed by recent versions of some browsers and tools (Firefox, for example). Your current certificate will keep working everywhere it works today. If you find that a browser or tool rejects it, press \"Re-generate certificates\" below, then re-import the newly generated certificate wherever you had trusted the old one.",
      });
    }
  }

  /**
   * Prepares a setting item to hold arbitrary block content, and returns the
   * element to render into.
   *
   * Two things are going on here. `.setting-item` lays its children out as a
   * flex row -- name/desc on the left, control on the right -- so block content
   * written straight into one ends up side-by-side rather than stacked. And
   * every styles.css rule for content this plugin renders itself is scoped to
   * the class added here.
   *
   * That scope lives on the setting item rather than on the settings tab's
   * containerEl on purpose: a `type: "page"` item renders into its own
   * SettingPage container, which is not a descendant of containerEl, so a rule
   * scoped to the tab root silently stops applying once the content moves onto
   * the Certificates or Advanced settings page.
   */
  private prepareCustomContent(setting: Setting): HTMLElement {
    setting.settingEl.empty();
    setting.settingEl.addClass("obsidian-local-rest-api-content");
    return setting.settingEl;
  }

  private confirmDestructiveAction(options: {
    title: string;
    message: string;
    confirmText: string;
    onConfirm: () => void;
  }): void {
    const modal = new ConfirmationModal(this.app);
    modal.titleEl.setText(options.title);
    modal.contentEl.createEl("p", { text: options.message });
    modal.addButton((btn) => {
      btn.setButtonText(options.confirmText)
        .setDestructive()
        .onClick(() => {
          options.onConfirm();
        });
    });
    modal.addCancelButton();
    modal.open();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    this.containerEl.classList.add("obsidian-local-rest-api-settings");

    const { remainingCertificateValidityDays, standardsIssue } =
      this.getCertificateStatus();

    const certificateDisplayValue = (): string => {
      if (remainingCertificateValidityDays === null) return "";
      if (remainingCertificateValidityDays < 0) return "Expired";
      if (remainingCertificateValidityDays < 30) {
        const days = Math.floor(remainingCertificateValidityDays);
        return `Expires in ${days} day${days === 1 ? "" : "s"}`;
      }
      if (standardsIssue === "legacy-ipv4-san") return "Should be regenerated";
      if (standardsIssue === "ca-used-as-leaf") return "Update available";
      return "Valid";
    };

    return [
      {
        type: "group",
        items: [
          {
            name: "Server status",
            render: (setting) => {
              const el = this.prepareCustomContent(setting);
              this.renderServerUrlTable(el, {
                pathSuffix: "/",
                secureName: "Encrypted (HTTPS) server",
                insecureName: "Non-encrypted (HTTP) server",
                copyLabel: "server URL",
                includeCertificateNote: false,
                disabledHint: "You can enable this in the settings below.",
              });
            },
          },
          {
            name: "API key",
            desc: `Passed as a bearer token via the ${
              this.plugin.settings.authorizationHeaderName ??
              DefaultBearerTokenHeaderName
            } header; see the "How to access" pages below for details.`,
            render: (setting) => {
              this.renderCopyableValue(
                setting.controlEl,
                this.plugin.settings.apiKey ?? "",
                "API key",
                "inline-copyable-value"
              );
            },
          },
          {
            type: "page",
            name: "How to access via REST",
            desc: "Connection URLs, authentication, and API documentation.",
            items: [
              {
                name: "How to access via REST",
                render: (setting) => {
                  this.renderConnectionInfo(this.prepareCustomContent(setting));
                },
              },
            ],
          },
          {
            type: "page",
            name: "How to access via MCP",
            desc: "MCP endpoints, authentication, and client configuration examples.",
            items: [
              {
                name: "How to access via MCP",
                render: (setting) => {
                  this.renderMcpInfo(this.prepareCustomContent(setting));
                },
              },
            ],
          },
        ],
      },
      {
        type: "group",
        heading: "Settings",
        items: [
          {
            name: "Enable non-encrypted (HTTP) server",
            desc: "Enables a non-encrypted (HTTP) server on the port designated below.  By default this plugin requires a secure HTTPS connection, but in safe environments you may turn on the non-encrypted server to simplify interacting with the API. Interactions with the API will still require the API key shown above.  Under no circumstances is it recommended that you expose this service to the internet, especially if you turn on this feature!",
            control: { type: "toggle", key: "enableInsecureServer" },
          },
          {
            type: "page",
            name: "Certificates",
            desc: "Regenerate certificates and edit certificate hostnames, key material, and the API key.",
            displayValue: certificateDisplayValue,
            status: standardsIssue === "legacy-ipv4-san" ? "warning" : null,
            items: this.getCertificateSettingDefinitions(),
          },
          {
            name: "Reset all cryptography",
            desc: "Regenerates your certificate, private key, public key, and API key. This settings panel will be closed when you confirm.",
            render: (setting) => {
              setting.addButton((cb) => {
                cb.setButtonText("Reset all crypto")
                  .setDestructive()
                  .onClick(() => {
                    this.confirmDestructiveAction({
                      title: "Reset all cryptography?",
                      message: "This regenerates your certificate, private key, public key, and API key, and closes this settings panel. This cannot be undone.",
                      confirmText: "Reset all crypto",
                      onConfirm: () => {
                        delete this.plugin.settings.apiKey;
                        delete this.plugin.settings.crypto;
                        void this.plugin.saveSettings();
                        this.plugin.unload();
                        this.plugin.load();
                      },
                    });
                  });
              });
            },
          },
          {
            name: "Restore default settings",
            desc: "Resets this plugin's settings to defaults. This settings panel will be closed when you confirm.",
            render: (setting) => {
              setting.addButton((cb) => {
                cb.setButtonText("Restore defaults")
                  .setDestructive()
                  .onClick(() => {
                    this.confirmDestructiveAction({
                      title: "Restore default settings?",
                      message: "This resets this plugin's settings to defaults and closes this settings panel. This cannot be undone.",
                      confirmText: "Restore defaults",
                      onConfirm: () => {
                        this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
                        void this.plugin.saveSettings();
                        this.plugin.unload();
                        this.plugin.load();
                      },
                    });
                  });
              });
            },
          },
          {
            type: "page",
            name: "Advanced settings",
            desc: "Advanced settings are dangerous and may make your environment less secure.",
            items: this.getAdvancedSettingDefinitions(),
          },
        ],
      },
    ];
  }

  private getAdvancedSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "License",
        render: (setting) => {
          const el = this.prepareCustomContent(setting);
          el.createEl("p", {
            text: `
              The settings below are potentially dangerous and
              are intended for use only by people who know what
              they are doing. Do not change any of these settings if
              you do not understand what that setting is used for
              and what security impacts changing that setting will have.
            `,
          });
          const noWarrantee = el.createEl("p");
          noWarrantee.createSpan({
            text: `
              Use of this software is licensed to you under the
              MIT license, and it is important that you understand that
              this license provides you with no warranty.
              For the complete license text please see
            `,
          });
          noWarrantee.createEl("a", {
            href: LicenseUrl,
            text: LicenseUrl,
          });
          noWarrantee.createSpan({ text: "." });
        },
      },
      {
        name: "Enable encrypted (HTTPS) server",
        desc: "This controls whether the HTTPS server is enabled.  You almost certainly want to leave this switch in its default state ('on'), but may find it useful to turn this switch off for troubleshooting.",
        control: { type: "toggle", key: "enableSecureServer" },
      },
      {
        name: "Encrypted (HTTPS) server port",
        desc: "This configures the port on which your REST API will listen for HTTPS connections.  It is recommended that you leave this port with its default setting as tools integrating with this API may expect the default port to be in use.  Under no circumstances is it recommended that you expose this service directly to the internet.",
        control: { type: "number", key: "port", min: 1, max: 65535 },
      },
      {
        name: "Non-encrypted (HTTP) server port",
        control: { type: "number", key: "insecurePort", min: 1, max: 65535 },
      },
      {
        name: "API key",
        control: { type: "text", key: "apiKey" },
      },
      {
        name: "Authorization header",
        control: { type: "text", key: "authorizationHeaderName" },
      },
      {
        name: "Binding host",
        control: { type: "text", key: "bindingHost" },
      },
      {
        name: "Enable verbose logging",
        desc: "When enabled, logs server startup messages and a one-line access log entry for every request to the browser console.",
        control: { type: "toggle", key: "enableVerboseLogging" },
      },
    ];
  }

  private getCertificateSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Certificate status",
        render: (setting) => {
          this.renderCertificateWarnings(this.prepareCustomContent(setting));
        },
      },
      {
        name: "Re-generate certificates",
        desc: "Regenerates your certificate authority, server certificate, and their keys; your API key remains unchanged. Anything that trusted the previous certificate will need to trust the new one. This settings panel will be closed when you press this.",
        render: (setting) => {
          setting.addButton((cb) => {
            cb.setButtonText("Re-generate certificates")
              .setDestructive()
              .onClick(() => {
                delete this.plugin.settings.crypto;
                void this.plugin.saveSettings();
                this.plugin.unload();
                this.plugin.load();
              });
          });
        },
      },
      {
        name: "Certificate hostnames",
        desc: 'List of extra hostnames to add to your certificate\'s `subjectAltName` field. One hostname per line. You must click the "Re-generate certificates" button above after changing this value for this to have an effect.  This is useful for situations in which you are accessing Obsidian from a hostname other than the host on which it is running.',
        control: { type: "textarea", key: "subjectAltNames" },
      },
      {
        name: "CA certificate",
        desc: "The certificate authority that signed the server certificate; this is what clients download and trust. Leave empty if your server certificate is self-signed.",
        control: { type: "textarea", key: "cryptoCaCert" },
      },
      {
        name: "CA private key",
        desc: "Used to renew the server certificate automatically before it expires. Leave empty to disable automatic renewal.",
        control: { type: "textarea", key: "cryptoCaPrivateKey" },
      },
      {
        name: "Server certificate",
        desc: "The certificate presented by the HTTPS server.",
        control: { type: "textarea", key: "cryptoCert" },
      },
      {
        name: "Server public key",
        control: { type: "textarea", key: "cryptoPublicKey" },
      },
      {
        name: "Server private key",
        control: { type: "textarea", key: "cryptoPrivateKey" },
      },
    ];
  }

  getControlValue(key: string): unknown {
    switch (key) {
      case "enableInsecureServer":
        return this.plugin.settings.enableInsecureServer;
      case "enableSecureServer":
        return this.plugin.settings.enableSecureServer ?? true;
      case "port":
        return this.plugin.settings.port;
      case "insecurePort":
        return this.plugin.settings.insecurePort;
      case "apiKey":
        return this.plugin.settings.apiKey ?? "";
      case "subjectAltNames":
        return this.plugin.settings.subjectAltNames ?? "";
      case "cryptoCert":
        return this.plugin.settings.crypto?.cert ?? "";
      case "cryptoPublicKey":
        return this.plugin.settings.crypto?.publicKey ?? "";
      case "cryptoPrivateKey":
        return this.plugin.settings.crypto?.privateKey ?? "";
      case "cryptoCaCert":
        return this.plugin.settings.crypto?.caCert ?? "";
      case "cryptoCaPrivateKey":
        return this.plugin.settings.crypto?.caPrivateKey ?? "";
      case "authorizationHeaderName":
        return (
          this.plugin.settings.authorizationHeaderName ??
          DefaultBearerTokenHeaderName
        );
      case "bindingHost":
        return this.plugin.settings.bindingHost ?? DefaultBindingHost;
      case "enableVerboseLogging":
        return this.plugin.settings.enableVerboseLogging ?? false;
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    switch (key) {
      case "enableInsecureServer":
        this.plugin.settings.enableInsecureServer = value as boolean;
        await this.plugin.saveSettings();
        this.plugin.refreshServerState();
        break;
      case "enableSecureServer":
        this.plugin.settings.enableSecureServer = value as boolean;
        await this.plugin.saveSettings();
        this.plugin.refreshServerState();
        break;
      case "port":
        this.plugin.settings.port = value as number;
        await this.plugin.saveSettings();
        this.plugin.refreshServerState();
        break;
      case "insecurePort":
        this.plugin.settings.insecurePort = value as number;
        await this.plugin.saveSettings();
        this.plugin.refreshServerState();
        break;
      case "apiKey":
        this.plugin.settings.apiKey = value as string;
        await this.plugin.saveSettings();
        this.plugin.refreshServerState();
        break;
      case "subjectAltNames":
        this.plugin.settings.subjectAltNames = value as string;
        await this.plugin.saveSettings();
        break;
      case "cryptoCert":
        if (this.plugin.settings.crypto) {
          this.plugin.settings.crypto.cert = value as string;
          await this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }
        break;
      case "cryptoPublicKey":
        if (this.plugin.settings.crypto) {
          this.plugin.settings.crypto.publicKey = value as string;
          await this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }
        break;
      case "cryptoPrivateKey":
        if (this.plugin.settings.crypto) {
          this.plugin.settings.crypto.privateKey = value as string;
          await this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }
        break;
      case "cryptoCaCert":
      case "cryptoCaPrivateKey": {
        // An empty CA field means "none", not an empty PEM: self-signed
        // material must not carry an empty string that later fails to parse.
        const field = key === "cryptoCaCert" ? "caCert" : "caPrivateKey";
        if (this.plugin.settings.crypto) {
          const text = (value as string).trim();
          if (text) {
            this.plugin.settings.crypto[field] = text;
          } else {
            delete this.plugin.settings.crypto[field];
          }
          await this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }
        break;
      }
      case "authorizationHeaderName":
        if (value !== DefaultBearerTokenHeaderName) {
          this.plugin.settings.authorizationHeaderName = value as string;
        } else {
          delete this.plugin.settings.authorizationHeaderName;
        }
        await this.plugin.saveSettings();
        this.plugin.refreshServerState();
        break;
      case "bindingHost":
        if (value !== DefaultBindingHost) {
          this.plugin.settings.bindingHost = value as string;
        } else {
          delete this.plugin.settings.bindingHost;
        }
        await this.plugin.saveSettings();
        this.plugin.refreshServerState();
        break;
      case "enableVerboseLogging":
        this.plugin.settings.enableVerboseLogging = (value as boolean) || undefined;
        await this.plugin.saveSettings();
        break;
    }
  }
}
