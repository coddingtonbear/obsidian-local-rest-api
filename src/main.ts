import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
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

  display(): void {
    const { containerEl } = this;
    containerEl.replaceChildren();

    const parsedCertificate = this.plugin.settings.crypto && forge.pki.certificateFromPem(
      this.plugin.settings.crypto.cert
    );
    const remainingCertificateValidityDays = parsedCertificate &&
      getCertificateValidityDays(parsedCertificate);
    const shouldRegenerateCertificate = parsedCertificate &&
      !getCertificateIsUptoStandards(parsedCertificate);

    containerEl.empty();
    containerEl.classList.add("obsidian-local-rest-api-settings");
    new Setting(containerEl).setHeading().setName("Local REST API & MCP server");
    new Setting(containerEl).setHeading().setName("How to access via REST");

    const apiKeyDiv = containerEl.createDiv();
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

    new Setting(containerEl).setHeading().setName("How to access via MCP");

    const mcpDiv = containerEl.createDiv();
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
    addUrlRow(mcpSecureUrlsTd, mcpSecureUrl);

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
    addUrlRow(mcpInsecureUrlsTd, mcpInsecureUrl);

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

    new Setting(containerEl).setHeading().setName("Settings");

    if (remainingCertificateValidityDays && remainingCertificateValidityDays < 0) {
      const expiredCertDiv = apiKeyDiv.createDiv();
      expiredCertDiv.classList.add("certificate-expired");
      expiredCertDiv.createEl("b", { text: "Your certificate has expired!" });
      expiredCertDiv.createSpan({
        text: ' You must re-generate your certificate below by pressing the "Re-generate Certificates" button below in order to connect securely to this API.',
      });
    } else if (remainingCertificateValidityDays &&remainingCertificateValidityDays < 30) {
      const soonExpiringCertDiv = apiKeyDiv.createDiv();
      soonExpiringCertDiv.classList.add("certificate-expiring-soon");
      const daysRemaining = Math.floor(remainingCertificateValidityDays);
      soonExpiringCertDiv.createEl("b", {
        text: `Your certificate will expire in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}!`,
      });
      soonExpiringCertDiv.createSpan({
        text: ' You should re-generate your certificate below by pressing the "Re-generate Certificates" button below in order to continue to connect securely to this API.',
      });
    }
    if (shouldRegenerateCertificate) {
      const shouldRegenerateCertificateDiv = apiKeyDiv.createDiv();
      shouldRegenerateCertificateDiv.classList.add(
        "certificate-regeneration-recommended"
      );
      shouldRegenerateCertificateDiv.createEl("b", {
        text: "You should re-generate your certificate!",
      });
      shouldRegenerateCertificateDiv.createSpan({
        text: " Your certificate was generated using earlier standards than are currently used by Obsidian Local REST API & MCP Server. Some systems or tools may not accept your certificate with its current configuration, and re-generating your certificate may improve compatibility with such tools.  To re-generate your certificate, press the \"Re-generate Certificates\" button below.",
      });
    }

    new Setting(containerEl)
      .setName("Enable non-encrypted (HTTP) server")
      .setDesc(
        "Enables a non-encrypted (HTTP) server on the port designated below.  By default this plugin requires a secure HTTPS connection, but in safe environments you may turn on the non-encrypted server to simplify interacting with the API. Interactions with the API will still require the API key shown above.  Under no circumstances is it recommended that you expose this service to the internet, especially if you turn on this feature!"
      )
      .addToggle((cb) =>
        cb
          .onChange((value) => {
            const originalValue = this.plugin.settings.enableInsecureServer;
            this.plugin.settings.enableInsecureServer = value;
            void this.plugin.saveSettings();
            this.plugin.refreshServerState();
            // If our target value differs,
            if (value !== originalValue) {
              this.display();
            }
          })
          .setValue(this.plugin.settings.enableInsecureServer)
      );

    new Setting(containerEl)
      .setName("Reset all cryptography")
      .setDesc(
        `Pressing this button will cause your certificate,
        private key, public key, and API key to be regenerated.
        This settings panel will be closed when you press this.`
      )
      .addButton((cb) => {
        cb.setWarning()
          .setButtonText("Reset all crypto")
          .onClick(() => {
            delete this.plugin.settings.apiKey;
            delete this.plugin.settings.crypto;
            void this.plugin.saveSettings();
            this.plugin.unload();
            this.plugin.load();
          });
      });

    new Setting(containerEl)
      .setName("Re-generate certificates")
      .setDesc(
        `Pressing this button will cause your certificate,
        private key,  and public key to be re-generated, but your API key will remain unchanged. 
        This settings panel will be closed when you press this.`
      )
      .addButton((cb) => {
        cb.setWarning()
          .setButtonText("Re-generate certificates")
          .onClick(() => {
            delete this.plugin.settings.crypto;
            void this.plugin.saveSettings();
            this.plugin.unload();
            this.plugin.load();
          });
      });

    new Setting(containerEl)
      .setName("Restore default settings")
      .setDesc(
        `Pressing this button will reset this plugin's
        settings to defaults.
        This settings panel will be closed when you press this.`
      )
      .addButton((cb) => {
        cb.setWarning()
          .setButtonText("Restore defaults")
          .onClick(() => {
            this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
            void this.plugin.saveSettings();
            this.plugin.unload();
            this.plugin.load();
          });
      });

    new Setting(containerEl)
      .setName("Show advanced settings")
      .setDesc(
        `Advanced settings are dangerous and may make your environment less secure.`
      )
      .addToggle((cb) => {
        cb.onChange((value) => {
          if (this.showAdvancedSettings !== value) {
            this.showAdvancedSettings = value;
            this.display();
          }
        }).setValue(this.showAdvancedSettings);
      });

    if (this.showAdvancedSettings) {
      new Setting(containerEl).setHeading().setName("Advanced settings");
      containerEl.createEl("p", {
        text: `
          The settings below are potentially dangerous and
          are intended for use only by people who know what
          they are doing. Do not change any of these settings if
          you do not understand what that setting is used for
          and what security impacts changing that setting will have.
        `,
      });
      const noWarrantee = containerEl.createEl("p");
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

      new Setting(containerEl)
        .setName("Enable encrypted (HTTPS) server")
        .setDesc(
          "\n          This controls whether the HTTPS server is enabled.  You almost certainly want to leave this switch in its default state ('on'),\n          but may find it useful to turn this switch off for\n          troubleshooting.\n        "
        )
        .addToggle((cb) =>
          cb
            .onChange((value) => {
              const originalValue = this.plugin.settings.enableSecureServer;
              this.plugin.settings.enableSecureServer = value;
              void this.plugin.saveSettings();
              this.plugin.refreshServerState();
              if (value !== originalValue) {
                this.display();
              }
            })
            .setValue(this.plugin.settings.enableSecureServer ?? true)
        );

      new Setting(containerEl)
        .setName("Encrypted (HTTPS) server port")
        .setDesc(
          "This configures the port on which your REST API will listen for HTTPS connections.  It is recommended that you leave this port with its default setting as tools integrating with this API may expect the default port to be in use.  Under no circumstances is it recommended that you expose this service directly to the internet."
        )
        .addText((cb) =>
          cb
            .onChange((value) => {
              this.plugin.settings.port = parseInt(value, 10);
              void this.plugin.saveSettings();
              this.plugin.refreshServerState();
            })
            .setValue(this.plugin.settings.port.toString())
        );

      new Setting(containerEl)
        .setName("Non-encrypted (HTTP) server port")
        .addText((cb) =>
          cb
            .onChange((value) => {
              this.plugin.settings.insecurePort = parseInt(value, 10);
              void this.plugin.saveSettings();
              this.plugin.refreshServerState();
            })
            .setValue(this.plugin.settings.insecurePort.toString())
        );

      new Setting(containerEl).setName("API key").addText((cb) => {
        cb.onChange((value) => {
          this.plugin.settings.apiKey = value;
          void this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }).setValue(this.plugin.settings.apiKey ?? "");
      });
      new Setting(containerEl)
        .setName("Certificate hostnames")
        .setDesc(
          `
          List of extra hostnames to add
          to your certificate's \`subjectAltName\` field.
          One hostname per line.
          You must click the "Re-generate Certificates" button above after changing this value
          for this to have an effect.  This is useful for
          situations in which you are accessing Obsidian
          from a hostname other than the host on which
          it is running.
      `
        )
        .addTextArea((cb) =>
          cb
            .onChange((value) => {
              this.plugin.settings.subjectAltNames = value;
              void this.plugin.saveSettings();
            })
            .setValue(this.plugin.settings.subjectAltNames ?? "")
        );
      new Setting(containerEl).setName("Certificate").addTextArea((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.crypto.cert = value;
            void this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.crypto.cert)
      );
      new Setting(containerEl).setName("Public key").addTextArea((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.crypto.publicKey = value;
            void this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.crypto.publicKey)
      );
      new Setting(containerEl).setName("Private key").addTextArea((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.crypto.privateKey = value;
            void this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.crypto.privateKey)
      );
      new Setting(containerEl).setName("Authorization header").addText((cb) => {
        cb.onChange((value) => {
          if (value !== DefaultBearerTokenHeaderName) {
            this.plugin.settings.authorizationHeaderName = value;
          } else {
            delete this.plugin.settings.authorizationHeaderName;
          }
          void this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }).setValue(
          this.plugin.settings.authorizationHeaderName ??
            DefaultBearerTokenHeaderName
        );
      });
      new Setting(containerEl).setName("Binding host").addText((cb) => {
        cb.onChange((value) => {
          if (value !== DefaultBindingHost) {
            this.plugin.settings.bindingHost = value;
          } else {
            delete this.plugin.settings.bindingHost;
          }
          void this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }).setValue(this.plugin.settings.bindingHost ?? DefaultBindingHost);
      });
      new Setting(containerEl)
        .setName("Enable verbose logging")
        .setDesc(
          "When enabled, logs server startup messages and a one-line access log entry for every request to the browser console."
        )
        .addToggle((cb) =>
          cb
            .onChange((value) => {
              this.plugin.settings.enableVerboseLogging = value || undefined;
              void this.plugin.saveSettings();
            })
            .setValue(this.plugin.settings.enableVerboseLogging ?? false)
        );
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
