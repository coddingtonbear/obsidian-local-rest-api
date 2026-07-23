import {
  App,
  ConfirmationModal,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
} from "obsidian";
import * as https from "https";
import * as http from "http";
import forge, { pki } from "node-forge";

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
  getCertificateIsUptoStandards,
  getCertificateValidityDays,
} from "./utils";
import LocalRestApiPublicApi, { ApiVersionUnsupportedError } from "./api";
export { ApiVersionUnsupportedError } from "./api";
import { PluginManifest } from "obsidian";
import { configureHttpServerTimeouts } from "./serverTimeouts";

export default class LocalRestApi extends Plugin {
  settings: LocalRestApiSettings;
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
      const expiry = new Date();
      const today = new Date();
      expiry.setDate(today.getDate() + 365);

      const keypair = forge.pki.rsa.generateKeyPair(2048);
      const attrs = [
        {
          name: "commonName",
          value: "Obsidian Local REST API",
        },
      ];
      const certificate = forge.pki.createCertificate();
      certificate.setIssuer(attrs);
      certificate.setSubject(attrs);

      const subjectAltNames: Record<string, unknown>[] = [
        {
          type: 7, // IP
          ip: DefaultBindingHost,
        },
      ];
      if (
        this.settings.bindingHost &&
        this.settings.bindingHost !== "0.0.0.0"
      ) {
        subjectAltNames.push({
          type: 7, // IP
          ip: this.settings.bindingHost,
        });
      }
      if (this.settings.subjectAltNames) {
        for (const name of this.settings.subjectAltNames.split("\n")) {
          if (name.trim()) {
            subjectAltNames.push({
              type: 2,
              value: name.trim(),
            });
          }
        }
      }

      certificate.setExtensions([
        {
          name: "basicConstraints",
          cA: true,
          critical: true,
        },
        {
          name: "keyUsage",
          keyCertSign: true,
          digitalSignature: true,
          nonRepudiation: true,
          keyEncipherment: false,
          dataEncipherment: false,
          critical: true,
        },
        {
          name: "extKeyUsage",
          serverAuth: true,
          clientAuth: true,
          codeSigning: true,
          emailProtection: true,
          timeStamping: true,
        },
        {
          name: "nsCertType",
          client: true,
          server: true,
          email: true,
          objsign: true,
          sslCA: true,
          emailCA: true,
          objCA: true,
        },
        {
          name: "subjectAltName",
          altNames: subjectAltNames,
        },
      ]);
      certificate.serialNumber = "1";
      certificate.publicKey = keypair.publicKey;
      certificate.validity.notAfter = expiry;
      certificate.validity.notBefore = today;
      certificate.sign(keypair.privateKey, forge.md.sha256.create());

      this.settings.crypto = {
        cert: pki.certificateToPem(certificate),
        privateKey: pki.privateKeyToPem(keypair.privateKey),
        publicKey: pki.publicKeyToPem(keypair.publicKey),
      };
      await this.saveSettings();
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
          cert: this.settings.crypto.cert,
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
  showAdvancedSettings = false;

  constructor(app: App, plugin: LocalRestApi) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private getCertificateStatus(): {
    remainingCertificateValidityDays: number | null;
    shouldRegenerateCertificate: boolean;
  } {
    const parsedCertificate = this.plugin.settings.crypto && forge.pki.certificateFromPem(
      this.plugin.settings.crypto.cert
    );
    return {
      remainingCertificateValidityDays: parsedCertificate
        ? getCertificateValidityDays(parsedCertificate)
        : null,
      shouldRegenerateCertificate: parsedCertificate
        ? !getCertificateIsUptoStandards(parsedCertificate)
        : false,
    };
  }

  private renderConnectionInfo(el: HTMLElement): void {
    new Setting(el).setHeading().setName("Local REST API with MCP");
    new Setting(el).setHeading().setName("How to access via REST");

    const apiKeyDiv = el.createDiv();
    apiKeyDiv.classList.add("api-key-display");

    apiKeyDiv.createEl("p", {
      text: "You can access Obsidian local REST API & MCP server via the following URLs:",
    });

    const addUrlRow = (container: HTMLElement, url: string) => {
      container.createEl("pre", { text: url });
    };

    const connectionUrls = apiKeyDiv.createEl("table", { cls: "api-urls" });
    const connectionUrlsTbody = connectionUrls.createEl("tbody");
    const secureTr = connectionUrlsTbody.createEl(
      "tr",
      this.plugin.settings.enableSecureServer === false
        ? {
            cls: "disabled",
            title: "Disabled.  You can enable this in 'Settings' below.",
          }
        : {
            title: "Enabled",
          }
    );
    const secureUrl = `https://127.0.0.1:${this.plugin.settings.port}/`;

    secureTr.createEl("td", {
      text: this.plugin.settings.enableSecureServer === false ? "❌" : "✅",
    });
    const secureNameTd = secureTr.createEl("td", { cls: "name" });
    secureNameTd.createSpan({ text: "Encrypted (HTTPS) API URL" });
    secureNameTd.createEl("br");
    secureNameTd.createEl("br");
    const secureNote = secureNameTd.createEl("i");
    secureNote.createSpan({ text: "Requires that " });
    secureNote.createEl("a", {
      href: `https://127.0.0.1:${this.plugin.settings.port}/${CERT_NAME}`,
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      text: "this certificate",
    });
    secureNote.createSpan({
      text: " be configured as a trusted certificate authority for your browser.  See ",
    });
    secureNote.createEl("a", {
      href: "https://github.com/coddingtonbear/obsidian-web/wiki/How-do-I-get-my-browser-trust-my-Obsidian-Local-REST-API-certificate%3F",
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      text: "wiki",
    });
    secureNote.createSpan({ text: " for more information." });

    const secureUrlsTd = secureTr.createEl("td", { cls: "url" });
    addUrlRow(secureUrlsTd, secureUrl);
    if (this.plugin.settings.subjectAltNames) {
      for (const name of this.plugin.settings.subjectAltNames.split("\n")) {
        if (name.trim()) {
          addUrlRow(
            secureUrlsTd,
            `https://${name.trim()}:${this.plugin.settings.port}/`
          );
        }
      }
    }

    const insecureTr = connectionUrlsTbody.createEl(
      "tr",
      this.plugin.settings.enableInsecureServer === false
        ? {
            cls: "disabled",
            title: "Disabled.  You can enable this in 'Settings' below.",
          }
        : {
            title: "Enabled",
          }
    );
    const insecureUrl = `http://127.0.0.1:${this.plugin.settings.insecurePort}/`;

    insecureTr.createEl("td", {
      text: this.plugin.settings.enableInsecureServer === false ? "❌" : "✅",
    });
    insecureTr.createEl("td", { cls: "name", text: "Non-encrypted (HTTP) API URL" });

    const insecureUrlsTd = insecureTr.createEl("td", { cls: "url" });
    addUrlRow(insecureUrlsTd, insecureUrl);
    if (this.plugin.settings.subjectAltNames) {
      for (const name of this.plugin.settings.subjectAltNames.split("\n")) {
        if (name.trim()) {
          addUrlRow(
            insecureUrlsTd,
            `http://${name.trim()}:${this.plugin.settings.insecurePort}/`
          );
        }
      }
    }

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

    apiKeyDiv.createEl("pre", {
      text: `Bearer ${this.plugin.settings.apiKey}`,
    });
    const seeMore = apiKeyDiv.createEl("p");
    seeMore.createSpan({
      text: "Comprehensive documentation of what API endpoints are available can be found in ",
    });
    seeMore.createEl("a", {
      href: "https://coddingtonbear.github.io/obsidian-local-rest-api/",
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      text: "the online docs",
    });
    seeMore.createSpan({ text: "." });
  }

  private renderMcpInfo(el: HTMLElement): void {
    new Setting(el).setHeading().setName("How to access via MCP");

    const mcpDiv = el.createDiv();
    mcpDiv.classList.add("mcp-display");

    mcpDiv.createEl("p", {
      text: "You can connect to the MCP server via the following endpoints:",
    });

    const mcpUrls = mcpDiv.createEl("table", { cls: "api-urls" });
    const mcpUrlsTbody = mcpUrls.createEl("tbody");

    const mcpSecureTr = mcpUrlsTbody.createEl(
      "tr",
      this.plugin.settings.enableSecureServer === false
        ? {
            cls: "disabled",
            title: "Disabled.  You can enable this in 'Settings' below.",
          }
        : {
            title: "Enabled",
          }
    );
    const mcpSecureUrl = `https://127.0.0.1:${this.plugin.settings.port}/mcp/`;

    mcpSecureTr.createEl("td", {
      text: this.plugin.settings.enableSecureServer === false ? "❌" : "✅",
    });
    const mcpSecureNameTd = mcpSecureTr.createEl("td", { cls: "name" });
    mcpSecureNameTd.createSpan({ text: "Encrypted (HTTPS) MCP Endpoint" });
    mcpSecureNameTd.createEl("br");
    mcpSecureNameTd.createEl("br");
    const mcpSecureNote = mcpSecureNameTd.createEl("i");
    mcpSecureNote.createSpan({ text: "Requires that " });
    mcpSecureNote.createEl("a", {
      href: `https://127.0.0.1:${this.plugin.settings.port}/${CERT_NAME}`,
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      text: "this certificate",
    });
    mcpSecureNote.createSpan({
      text: " be configured as a trusted certificate authority.  See ",
    });
    mcpSecureNote.createEl("a", {
      href: "https://github.com/coddingtonbear/obsidian-web/wiki/How-do-I-get-my-browser-trust-my-Obsidian-Local-REST-API-certificate%3F",
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      text: "wiki",
    });
    mcpSecureNote.createSpan({ text: " for more information." });

    const mcpSecureUrlsTd = mcpSecureTr.createEl("td", { cls: "url" });
    mcpSecureUrlsTd.createEl("pre", { text: mcpSecureUrl });

    const mcpInsecureTr = mcpUrlsTbody.createEl(
      "tr",
      this.plugin.settings.enableInsecureServer === false
        ? {
            cls: "disabled",
            title: "Disabled.  You can enable this in 'Settings' below.",
          }
        : {
            title: "Enabled",
          }
    );
    const mcpInsecureUrl = `http://127.0.0.1:${this.plugin.settings.insecurePort}/mcp/`;

    mcpInsecureTr.createEl("td", {
      text: this.plugin.settings.enableInsecureServer === false ? "❌" : "✅",
    });
    mcpInsecureTr.createEl("td", {
      cls: "name",
      text: "Non-encrypted (HTTP) MCP endpoint",
    });

    const mcpInsecureUrlsTd = mcpInsecureTr.createEl("td", { cls: "url" });
    mcpInsecureUrlsTd.createEl("pre", { text: mcpInsecureUrl });

    const headerName =
      this.plugin.settings.authorizationHeaderName ??
      DefaultBearerTokenHeaderName;

    const mcpAuthHeaderP = mcpDiv.createEl("p");
    mcpAuthHeaderP.createSpan({
      text: "Your API key should be passed as a bearer token via the ",
    });
    mcpAuthHeaderP.createEl("code", { text: headerName });
    mcpAuthHeaderP.createSpan({ text: " header:" });

    mcpDiv.createEl("pre", {
      text: `Bearer ${this.plugin.settings.apiKey}`,
    });
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
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      text: "the project readme",
    });
    mcpSeeMore.createSpan({ text: "." });
  }

  private renderCertificateWarnings(el: HTMLElement): void {
    const { remainingCertificateValidityDays, shouldRegenerateCertificate } =
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
    if (shouldRegenerateCertificate) {
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
    }
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

    const { remainingCertificateValidityDays, shouldRegenerateCertificate } =
      this.getCertificateStatus();

    const certificateDisplayValue = (): string => {
      if (remainingCertificateValidityDays === null) return "";
      if (remainingCertificateValidityDays < 0) return "Expired";
      if (remainingCertificateValidityDays < 30) {
        const days = Math.floor(remainingCertificateValidityDays);
        return `Expires in ${days} day${days === 1 ? "" : "s"}`;
      }
      if (shouldRegenerateCertificate) return "Should be regenerated";
      return "Valid";
    };

    return [
      {
        type: "group",
        items: [
          {
            name: "Connection information",
            desc: "REST and MCP connection URLs and API key.",
            render: (setting) => {
              setting.settingEl.empty();
              setting.settingEl.addClass("full-width-setting");
              this.renderConnectionInfo(setting.settingEl);
              this.renderMcpInfo(setting.settingEl);
            },
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
            status: shouldRegenerateCertificate ? "warning" : null,
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
            name: "Show advanced settings",
            desc: "Advanced settings are dangerous and may make your environment less secure.",
            control: { type: "toggle", key: "showAdvancedSettings" },
          },
        ],
      },
      {
        type: "group",
        heading: "Advanced settings",
        visible: () => this.showAdvancedSettings,
        items: [
          {
            name: "License",
            render: (setting, group) => {
              setting.settingEl.remove();
              group.listEl.createEl("p", {
                text: `
                  The settings below are potentially dangerous and
                  are intended for use only by people who know what
                  they are doing. Do not change any of these settings if
                  you do not understand what that setting is used for
                  and what security impacts changing that setting will have.
                `,
              });
              const noWarrantee = group.listEl.createEl("p");
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
        ],
      },
    ];
  }

  private getCertificateSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Certificate status",
        render: (setting) => {
          setting.settingEl.empty();
          setting.settingEl.addClass("full-width-setting");
          this.renderCertificateWarnings(setting.settingEl);
        },
      },
      {
        name: "Re-generate certificates",
        desc: "Regenerates your certificate, private key, and public key; your API key remains unchanged. This settings panel will be closed when you press this.",
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
        name: "Certificate",
        control: { type: "textarea", key: "cryptoCert" },
      },
      {
        name: "Public key",
        control: { type: "textarea", key: "cryptoPublicKey" },
      },
      {
        name: "Private key",
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
      case "authorizationHeaderName":
        return (
          this.plugin.settings.authorizationHeaderName ??
          DefaultBearerTokenHeaderName
        );
      case "bindingHost":
        return this.plugin.settings.bindingHost ?? DefaultBindingHost;
      case "enableVerboseLogging":
        return this.plugin.settings.enableVerboseLogging ?? false;
      case "showAdvancedSettings":
        return this.showAdvancedSettings;
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
      case "showAdvancedSettings":
        this.showAdvancedSettings = value as boolean;
        this.refreshDomState();
        break;
    }
  }
}

export const getAPI = (
  app: App,
  manifest: PluginManifest,
  version?: number,
): LocalRestApiPublicApi | undefined => {
  const plugin = app.plugins.plugins["obsidian-local-rest-api"];
  if (!plugin) return undefined;
  const api = (plugin as unknown as LocalRestApi).getPublicApi(manifest);
  if (version !== undefined) {
    const availableVersion = api.apiVersion ?? 1;
    if (availableVersion < version) {
      throw new ApiVersionUnsupportedError(version, availableVersion);
    }
  }
  return api;
};
