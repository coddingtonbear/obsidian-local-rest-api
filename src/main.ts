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
import { getCurrentLanguage, t } from "./i18n";

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
  getReportedValidityDays,
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
  requestHandler!: RequestHandler;
  refreshServerState!: () => void;

  async onload() {
    this.refreshServerState = this.debounce(
      this._refreshServerState.bind(this),
      1000,
    );

    await this.loadSettings();

    this.requestHandler = new RequestHandler(
      this.app,
      this.manifest,
      this.settings,
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
          console.debug(
            "[REST API] Renewed the server certificate from the stored CA",
          );
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
        "PluginManifest instance must include a defined id, name, and version to be accempted.",
      );
    }

    if (this.settings.enableVerboseLogging) {
      console.debug("[REST API] Added new API extension", pluginManifest);
    }

    return this.requestHandler.registerApiExtension(pluginManifest);
  }

  debounce<F extends (...args: unknown[]) => unknown>(
    func: F,
    delay: number,
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
        this.requestHandler.api,
      );
      configureHttpServerTimeouts(this.secureServer);
      this.secureServer.listen(
        this.settings.port,
        this.settings.bindingHost ?? DefaultBindingHost,
      );

      if (this.settings.enableVerboseLogging) {
        console.debug(
          `[REST API] Listening on https://${
            this.settings.bindingHost ?? DefaultBindingHost
          }:${this.settings.port}/`,
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
        this.settings.bindingHost ?? DefaultBindingHost,
      );

      if (this.settings.enableVerboseLogging) {
        console.debug(
          `[REST API] Listening on http://${
            this.settings.bindingHost ?? DefaultBindingHost
          }:${this.settings.insecurePort}/`,
        );
      }
    }
  }

  onunload() {
    this.requestHandler?.mcpHandler.close();
    this.requestHandler?.operations.dispose();
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
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<LocalRestApiSettings>,
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

export class LocalRestApiSettingTab extends PluginSettingTab {
  plugin: LocalRestApi;

  constructor(app: App, plugin: LocalRestApi) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Summarises the stored certificate material for the settings UI. See
   * getReportedValidityDays for which certificate's expiry is reported.
   */
  private getCertificateStatus(): {
    remainingCertificateValidityDays: number | null;
    standardsIssue: CertificateStandardsIssue | null;
  } {
    const crypto = this.plugin.settings.crypto;
    if (!crypto) {
      return { remainingCertificateValidityDays: null, standardsIssue: null };
    }
    let standardsIssue: CertificateStandardsIssue | null = null;
    try {
      standardsIssue = getCertificateStandardsIssue(
        forge.pki.certificateFromPem(crypto.cert),
      );
    } catch {
      // Unparseable material: nothing to say about its standards either.
    }
    return {
      remainingCertificateValidityDays: getReportedValidityDays(crypto),
      standardsIssue,
    };
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
    cls = "copyable-value",
  ): void {
    const wrapper = el.createDiv({ cls });
    wrapper.createEl("pre", { text: value });
    new ExtraButtonComponent(wrapper)
      .setIcon("copy")
      .setTooltip(t("copy.tooltip", { label }))
      .onClick(() => {
        void this.copyToClipboard(value, label);
      });
  }

  private async copyToClipboard(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      new Notice(t("copy.success", { label }));
    } catch {
      // writeText rejects when the document is not focused or the platform
      // refuses permission. The notice is this button's only feedback, so
      // swallowing the rejection would make a failed copy indistinguishable
      // from a successful one.
      new Notice(t("copy.failure", { label }));
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
    },
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
          ? { title: t("status.enabled") }
          : {
              cls: "disabled",
              title: t("status.disabled", { hint: options.disabledHint }),
            },
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

    const certificateLinkLabel = t("link.certificate");
    const wikiLinkLabel = t("link.wiki");

    addRow({
      enabled: settings.enableSecureServer !== false,
      name: options.secureName,
      urls: [
        `https://127.0.0.1:${settings.port}${options.pathSuffix}`,
        ...altNames.map(
          (name) => `https://${name}:${settings.port}${options.pathSuffix}`,
        ),
      ],
      note: options.includeCertificateNote
        ? (noteEl) => {
            const certUrl = `https://127.0.0.1:${settings.port}/${CERT_NAME}`;
            const wikiUrl =
              "https://github.com/coddingtonbear/obsidian-web/wiki/How-do-I-get-my-browser-trust-my-Obsidian-Local-REST-API-certificate%3F";

            const secureNoteTemplate = t("rest.secureNote", {
              link: "{{LINK}}",
              wikiLink: "{{WIKI}}",
            });
            const parts = secureNoteTemplate.split(/\{\{LINK\}\}|\{\{WIKI\}\}/);
            const placeholders =
              secureNoteTemplate.match(/\{\{LINK\}\}|\{\{WIKI\}\}/g) ?? [];

            noteEl.createSpan({ text: parts[0] });

            for (let i = 0; i < placeholders.length; i++) {
              const placeholder = placeholders[i];
              const url = placeholder === "{{LINK}}" ? certUrl : wikiUrl;
              const label =
                placeholder === "{{LINK}}"
                  ? certificateLinkLabel
                  : wikiLinkLabel;
              noteEl.createEl("a", {
                href: url,
                text: label,
                attr: { target: "_blank" },
              });
              if (parts[i + 1]) {
                noteEl.createSpan({ text: parts[i + 1] });
              }
            }
          }
        : undefined,
    });

    addRow({
      enabled: settings.enableInsecureServer !== false,
      name: options.insecureName,
      urls: [
        `http://127.0.0.1:${settings.insecurePort}${options.pathSuffix}`,
        ...altNames.map(
          (name) =>
            `http://${name}:${settings.insecurePort}${options.pathSuffix}`,
        ),
      ],
    });
  }

  private renderConnectionInfo(el: HTMLElement): void {
    const apiKeyDiv = el.createDiv();
    apiKeyDiv.classList.add("api-key-display");

    apiKeyDiv.createEl("p", {
      text: t("rest.intro"),
    });

    this.renderServerUrlTable(apiKeyDiv, {
      pathSuffix: "/",
      secureName: t("rest.secureName"),
      insecureName: t("rest.insecureName"),
      copyLabel: t("rest.endpointUrl"),
      includeCertificateNote: true,
      disabledHint: t("rest.disabledHint"),
    });

    const authHeaderP = apiKeyDiv.createEl("p");
    // The i18n key contains an HTML <code> tag around {header}.  We split
    // around a sentinel so the real header name goes into a safe text node
    // on a <code> element — never through innerHTML.
    const headerName =
      this.plugin.settings.authorizationHeaderName ??
      DefaultBearerTokenHeaderName;
    const authHeaderTemplate = t("rest.authHeader", { header: "\u0000" });
    const [authBefore, authAfter] = authHeaderTemplate.split(
      "<code>\u0000</code>",
    );
    authHeaderP.createSpan({ text: authBefore });
    authHeaderP.createEl("code", { text: headerName });
    authHeaderP.createSpan({ text: authAfter });

    this.renderCopyableValue(
      apiKeyDiv,
      `Bearer ${this.plugin.settings.apiKey}`,
      t("rest.authLabel"),
    );

    apiKeyDiv.createEl("p", {
      text: t("rest.apiKeyHint"),
    });
    this.renderCopyableValue(
      apiKeyDiv,
      this.plugin.settings.apiKey ?? "",
      t("setting.apiKey"),
    );

    const seeMore = apiKeyDiv.createEl("p");
    seeMore.createSpan({
      text: t("rest.seeMore", { docsLink: "" }),
    });
    seeMore.createEl("a", {
      href: "https://coddingtonbear.github.io/obsidian-local-rest-api/",
      text: t("link.docs"),
    });
    seeMore.createSpan({ text: "." });
  }

  private renderMcpInfo(el: HTMLElement): void {
    const mcpDiv = el.createDiv();
    mcpDiv.classList.add("mcp-display");

    mcpDiv.createEl("p", {
      text: t("mcp.intro"),
    });

    this.renderServerUrlTable(mcpDiv, {
      pathSuffix: "/mcp/",
      secureName: t("mcp.secureName"),
      insecureName: t("mcp.insecureName"),
      copyLabel: t("mcp.endpointUrl"),
      includeCertificateNote: true,
      disabledHint: t("mcp.disabledHint"),
    });

    const mcpSecureUrl = `https://127.0.0.1:${this.plugin.settings.port}/mcp/`;

    const headerName =
      this.plugin.settings.authorizationHeaderName ??
      DefaultBearerTokenHeaderName;

    const mcpAuthHeaderP = mcpDiv.createEl("p");
    // Split the i18n template around the <code> sentinel so the real header
    // name is inserted as a safe text node, not via innerHTML.
    const mcpAuthHeaderTemplate = t("mcp.authHeader", { header: "\u0000" });
    const [mcpAuthBefore, mcpAuthAfter] = mcpAuthHeaderTemplate.split(
      "<code>\u0000</code>",
    );
    mcpAuthHeaderP.createSpan({ text: mcpAuthBefore });
    mcpAuthHeaderP.createEl("code", { text: headerName });
    mcpAuthHeaderP.createSpan({ text: mcpAuthAfter });

    this.renderCopyableValue(
      mcpDiv,
      `Bearer ${this.plugin.settings.apiKey}`,
      t("mcp.authLabel"),
    );

    mcpDiv.createEl("p", {
      text: t("mcp.apiKeyHint"),
    });
    this.renderCopyableValue(
      mcpDiv,
      this.plugin.settings.apiKey ?? "",
      t("setting.apiKey"),
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
      2,
    );

    mcpDiv.createEl("p", {
      text: t("mcp.example"),
    });
    mcpDiv.createEl("pre", { text: mcpSampleConfig });

    const mcpSeeMore = mcpDiv.createEl("p");
    mcpSeeMore.createSpan({
      text: t("mcp.seeMore", { docsLink: "" }),
    });
    mcpSeeMore.createEl("a", {
      href: "https://github.com/coddingtonbear/obsidian-local-rest-api#readme",
      text: t("link.readme"),
    });
    mcpSeeMore.createSpan({ text: "." });
  }

  private renderCertificateWarnings(el: HTMLElement): void {
    const { remainingCertificateValidityDays, standardsIssue } =
      this.getCertificateStatus();

    if (
      remainingCertificateValidityDays !== null &&
      remainingCertificateValidityDays < 0
    ) {
      const expiredCertDiv = el.createDiv();
      expiredCertDiv.classList.add("certificate-expired");
      expiredCertDiv.createEl("b", { text: t("status.expired") });
      expiredCertDiv.createSpan({
        text: t("status.expiredDesc"),
      });
    } else if (
      remainingCertificateValidityDays !== null &&
      remainingCertificateValidityDays < 30
    ) {
      const soonExpiringCertDiv = el.createDiv();
      soonExpiringCertDiv.classList.add("certificate-expiring-soon");
      const daysRemaining = Math.floor(remainingCertificateValidityDays);
      soonExpiringCertDiv.createEl("b", {
        text: t("status.expiringSoon", {
          days: daysRemaining,
          suffix: daysRemaining === 1 ? "" : "s",
        }),
      });
      soonExpiringCertDiv.createSpan({
        text: t("status.expiringDesc"),
      });
    }
    if (standardsIssue === "legacy-ipv4-san") {
      const shouldRegenerateCertificateDiv = el.createDiv();
      shouldRegenerateCertificateDiv.classList.add(
        "certificate-regeneration-recommended",
      );
      shouldRegenerateCertificateDiv.createEl("b", {
        text: t("status.regenerate"),
      });
      shouldRegenerateCertificateDiv.createSpan({
        text: t("status.regenerateDesc"),
      });
    } else if (standardsIssue === "ca-used-as-leaf") {
      // Deliberately mild: nothing is broken for anyone this certificate
      // already works for, and regenerating costs them a re-import.
      const updateAvailableDiv = el.createDiv();
      updateAvailableDiv.classList.add("certificate-update-available");
      updateAvailableDiv.createSpan({
        text: t("cert.caUpdate"),
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
      btn
        .setButtonText(options.confirmText)
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
      if (remainingCertificateValidityDays < 0) return t("cert.expired");
      if (remainingCertificateValidityDays < 30) {
        const days = Math.floor(remainingCertificateValidityDays);
        return t("cert.expiresIn", {
          days,
          suffix: getCurrentLanguage() === "en" && days !== 1 ? "s" : "",
        });
      }
      if (standardsIssue === "legacy-ipv4-san")
        return t("cert.shouldRegenerate");
      if (standardsIssue === "ca-used-as-leaf")
        return t("cert.updateAvailable");
      return t("cert.valid");
    };

    return [
      {
        type: "group",
        items: [
          {
            name: t("rest.serverStatus"),
            render: (setting) => {
              const el = this.prepareCustomContent(setting);
              this.renderServerUrlTable(el, {
                pathSuffix: "/",
                secureName: t("rest.secureServerName"),
                insecureName: t("rest.insecureServerName"),
                copyLabel: t("rest.serverUrlCopyLabel"),
                includeCertificateNote: false,
                disabledHint: t("rest.disabledHint"),
              });
            },
          },
          {
            name: t("setting.apiKey"),
            desc: t("rest.apiKeyDesc", {
              header:
                this.plugin.settings.authorizationHeaderName ??
                DefaultBearerTokenHeaderName,
            }),
            render: (setting) => {
              this.renderCopyableValue(
                setting.controlEl,
                this.plugin.settings.apiKey ?? "",
                t("setting.apiKey"),
                "inline-copyable-value",
              );
            },
          },
          {
            type: "page",
            name: t("heading.rest"),
            desc: t("rest.howToAccessDesc"),
            items: [
              {
                name: t("heading.rest"),
                render: (setting) => {
                  this.renderConnectionInfo(this.prepareCustomContent(setting));
                },
              },
            ],
          },
          {
            type: "page",
            name: t("heading.mcp"),
            desc: t("mcp.howToAccessDesc"),
            items: [
              {
                name: t("heading.mcp"),
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
        heading: t("heading.settings"),
        items: [
          {
            name: t("setting.insecureServer"),
            desc: t("setting.insecureServerDesc"),
            control: { type: "toggle", key: "enableInsecureServer" },
          },
          {
            type: "page",
            name: t("setting.certificates"),
            desc: t("setting.certificatesDesc"),
            displayValue: certificateDisplayValue,
            status: standardsIssue === "legacy-ipv4-san" ? "warning" : null,
            items: this.getCertificateSettingDefinitions(),
          },
          {
            name: t("setting.resetCrypto"),
            desc: t("setting.resetCryptoDesc"),
            render: (setting) => {
              setting.addButton((cb) => {
                cb.setButtonText(t("setting.resetCryptoBtn"))
                  .setDestructive()
                  .onClick(() => {
                    this.confirmDestructiveAction({
                      title: t("modal.resetTitle"),
                      message: t("modal.resetMessage"),
                      confirmText: t("setting.resetCryptoBtn"),
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
            name: t("setting.restoreDefaults"),
            desc: t("setting.restoreDefaultsDesc"),
            render: (setting) => {
              setting.addButton((cb) => {
                cb.setButtonText(t("setting.restoreDefaultsBtn"))
                  .setDestructive()
                  .onClick(() => {
                    this.confirmDestructiveAction({
                      title: t("modal.restoreTitle"),
                      message: t("modal.restoreMessage"),
                      confirmText: t("setting.restoreDefaultsBtn"),
                      onConfirm: () => {
                        this.plugin.settings = Object.assign(
                          {},
                          DEFAULT_SETTINGS,
                        );
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
            name: t("setting.advancedSettingsHeading"),
            desc: t("setting.advancedSettingsDesc"),
            items: this.getAdvancedSettingDefinitions(),
          },
        ],
      },
    ];
  }

  private getAdvancedSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: t("advanced.license"),
        render: (setting) => {
          const el = this.prepareCustomContent(setting);
          el.createEl("p", {
            text: t("advanced.warning"),
          });
          const noWarrantee = el.createEl("p");
          // Split around a {licenseLink} sentinel so the URL goes into a
          // safe <a> element — never via innerHTML.
          const licenseTemplate = t("advanced.noWarranty", {
            licenseLink: "\u0000",
          });
          const [licBefore, licAfter] = licenseTemplate.split("\u0000");
          noWarrantee.createSpan({ text: licBefore });
          noWarrantee.createEl("a", {
            href: LicenseUrl,
            text: LicenseUrl,
          });
          noWarrantee.createSpan({ text: licAfter });
        },
      },
      {
        name: t("setting.enableSecureServer"),
        desc: t("setting.enableSecureServerDesc"),
        control: { type: "toggle", key: "enableSecureServer" },
      },
      {
        name: t("setting.securePort"),
        desc: t("setting.securePortDesc"),
        control: { type: "number", key: "port", min: 1, max: 65535 },
      },
      {
        name: t("setting.insecurePort"),
        control: { type: "number", key: "insecurePort", min: 1, max: 65535 },
      },
      {
        name: t("setting.apiKey"),
        control: { type: "text", key: "apiKey" },
      },
      {
        name: t("setting.authorizationHeader"),
        control: { type: "text", key: "authorizationHeaderName" },
      },
      {
        name: t("setting.bindingHost"),
        control: { type: "text", key: "bindingHost" },
      },
      {
        name: t("setting.verboseLogging"),
        desc: t("setting.verboseLoggingDesc"),
        control: { type: "toggle", key: "enableVerboseLogging" },
      },
    ];
  }

  private getCertificateSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: t("cert.status"),
        render: (setting) => {
          this.renderCertificateWarnings(this.prepareCustomContent(setting));
        },
      },
      {
        name: t("setting.regenerateCert"),
        desc: t("setting.regenerateCertDesc"),
        render: (setting) => {
          setting.addButton((cb) => {
            cb.setButtonText(t("setting.regenerateCertBtn"))
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
        name: t("setting.certificateHostnames"),
        desc: t("setting.certificateHostnamesDesc"),
        control: { type: "textarea", key: "subjectAltNames" },
      },
      {
        name: t("advanced.caCert"),
        desc: t("advanced.caCertDesc"),
        control: { type: "textarea", key: "cryptoCaCert" },
      },
      {
        name: t("advanced.caPrivateKey"),
        desc: t("advanced.caPrivateKeyDesc"),
        control: { type: "textarea", key: "cryptoCaPrivateKey" },
      },
      {
        name: t("advanced.serverCert"),
        desc: t("advanced.serverCertDesc"),
        control: { type: "textarea", key: "cryptoCert" },
      },
      {
        name: t("advanced.serverPublicKey"),
        control: { type: "textarea", key: "cryptoPublicKey" },
      },
      {
        name: t("advanced.serverPrivateKey"),
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
        this.plugin.settings.enableVerboseLogging =
          (value as boolean) || undefined;
        await this.plugin.saveSettings();
        break;
    }
  }
}
