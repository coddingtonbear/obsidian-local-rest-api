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
      this.saveSettings();
    }
    if (!this.settings.crypto) {
      const expiry = new Date();
      const today = new Date();
      expiry.setDate(today.getDate() + 365);

      const keypair = forge.pki.rsa.generateKeyPair(2048);
      const attrs = [{ name: "commonName", value: "Obsidian Local REST API" }];
      const certificate = forge.pki.createCertificate();
      certificate.setIssuer(attrs);
      certificate.setSubject(attrs);
      certificate.setExtensions([
        {
          name: "basicConstraints",
          cA: true,
        },
        {
          name: "keyUsage",
          keyCertSign: true,
          digitalSignature: true,
          nonRepudiation: true,
          keyEncipherment: true,
          dataEncipherment: true,
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
          altNames: [
            {
              type: 7, // IP
              ip: this.settings.bindingHost ?? DefaultBindingHost,
            },
          ],
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
      this.saveSettings();
    }

    this.addSettingTab(new LocalRestApiSettingTab(this.app, this));

    this.refreshServerState();
  }

  debounce<F extends (...args: any[]) => any>(
    func: F,
    delay: number
  ): (...args: Parameters<F>) => void {
    let debounceTimer: NodeJS.Timeout;
    return (...args: Parameters<F>): void => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => func(...args), delay);
    };
  }

  _refreshServerState() {
    if (this.secureServer) {
      this.secureServer.close();
      this.secureServer = null;
    }
    this.secureServer = https.createServer(
      { key: this.settings.crypto.privateKey, cert: this.settings.crypto.cert },
      this.requestHandler.api
    );
    this.secureServer.listen(
      this.settings.port,
      this.settings.bindingHost ?? DefaultBindingHost
    );

    console.log(
      `REST API listening on https://${
        this.settings.bindingHost ?? DefaultBindingHost
      }:${this.settings.port}/`
    );

    if (this.insecureServer) {
      this.insecureServer.close();
      this.insecureServer = null;
    }
    if (this.settings.enableInsecureServer) {
      this.insecureServer = http.createServer(this.requestHandler.api);
      this.insecureServer.listen(
        this.settings.insecurePort,
        this.settings.bindingHost ?? DefaultBindingHost
      );

      console.log(
        `REST API listening on http://${
          this.settings.bindingHost ?? DefaultBindingHost
        }:${this.settings.insecurePort}/`
      );
    }
  }

  onunload() {
    if (this.secureServer) {
      this.secureServer.close();
    }
    if (this.insecureServer) {
      this.insecureServer.close();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class LocalRestApiSettingTab extends PluginSettingTab {
  plugin: LocalRestApi;
  showAdvancedSettings: boolean = false;

  constructor(app: App, plugin: LocalRestApi) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();
    containerEl.classList.add("obsidian-local-rest-api-settings");

    const apiKeyDiv = containerEl.createEl("div");
    apiKeyDiv.classList.add("api-key-display");

    apiKeyDiv.createEl("h3", { text: "Your API Key" });
    apiKeyDiv.createEl("p", {
      text: "This must be passed in all requests via an authorization header.",
    });
    apiKeyDiv.createEl("pre", { text: this.plugin.settings.apiKey });
    apiKeyDiv.createEl("p", { text: "Example header: " });
    apiKeyDiv.createEl("pre", {
      text: `${
        this.plugin.settings.authorizationHeaderName ?? "Authorization"
      }: Bearer ${this.plugin.settings.apiKey}`,
    });

    const seeMore = apiKeyDiv.createEl("p");
    seeMore.createEl("a", {
      href: "https://coddingtonbear.github.io/obsidian-local-rest-api/",
      text: "See more information and examples in our interactive OpenAPI documentation.",
    });

    const importCert = apiKeyDiv.createEl("p");
    importCert.createEl("span", {
      text: "By default this plugin uses a self-signed certificate for HTTPS; you may want to ",
    });
    importCert.createEl("a", {
      href: `https://127.0.0.1:${this.plugin.settings.port}/${CERT_NAME}`,
      text: "download this certificate",
    });
    importCert.createEl("span", {
      text: " to use it for validating your connection's security by adding it as a trusted certificate authority in the browser or tool you are using for interacting with this API.",
    });

    new Setting(containerEl)
      .setName("Encrypted (HTTPS) Server Port")
      .setDesc(
        "This configures the port on which your REST API will listen for HTTPS connections.  It is recommended that you leave this port with its default setting as tools integrating with this API may expect the default port to be in use.  In no circumstance is it recommended that you expose this service directly to the internet."
      )
      .addText((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.port = parseInt(value, 10);
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.port.toString())
      );

    new Setting(containerEl)
      .setName("Enable Non-encrypted (HTTP) Server")
      .setDesc(
        "Enables an unencrypted (HTTP) server on the port designated below.  By default, this plugin requires a secure HTTPS connection, but in secure environments you may turn on the insecure server to simplify interacting with the API. Interactions with the API will still require the API Key shown above.  In no circumstances is it recommended that you expose this service to the internet, especially if you turn on this feature!"
      )
      .addToggle((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.enableInsecureServer = value;
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.enableInsecureServer)
      );

    new Setting(containerEl)
      .setName("Non-encrypted (HTTP) Server Port")
      .addText((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.insecurePort = parseInt(value, 10);
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.insecurePort.toString())
      );

    new Setting(containerEl)
      .setName("Reset Cryptography")
      .setDesc(
        `Pressing this button will cause all of your certificates
        to be immediately regenerated`
      )
      .addButton((cb) => {
        cb.setWarning()
          .setButtonText("Reset Crypo")
          .onClick(() => {
            delete this.plugin.settings.apiKey;
            delete this.plugin.settings.crypto;
            this.plugin.saveSettings();
            this.plugin.unload();
            this.plugin.load();
          });
      });

    new Setting(containerEl)
      .setName("Restore Default Settings")
      .setDesc(
        `Pressing this button will reset this plugin's
        settings to be restored to defaults.`
      )
      .addButton((cb) => {
        cb.setWarning()
          .setButtonText("Restore Defaults")
          .onClick(() => {
            this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
            this.plugin.saveSettings();
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
      containerEl.createEl("hr");
      containerEl.createEl("h3", {
        text: "Advanced Settings",
      });
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
      noWarrantee.createEl("span", {
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
      noWarrantee.createEl("span", { text: "." });

      new Setting(containerEl).setName("API Key").addText((cb) => {
        cb.onChange((value) => {
          this.plugin.settings.apiKey = value;
          this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }).setValue(this.plugin.settings.apiKey);
      });
      new Setting(containerEl).setName("Certificate").addTextArea((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.crypto.cert = value;
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.crypto.cert)
      );
      new Setting(containerEl).setName("Public Key").addTextArea((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.crypto.publicKey = value;
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.crypto.publicKey)
      );
      new Setting(containerEl).setName("Private Key").addTextArea((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.crypto.publicKey = value;
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.crypto.privateKey)
      );
      new Setting(containerEl).setName("Authorization Header").addText((cb) => {
        cb.onChange((value) => {
          if (value !== DefaultBearerTokenHeaderName) {
            this.plugin.settings.authorizationHeaderName = value;
          } else {
            delete this.plugin.settings.authorizationHeaderName;
          }
          this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }).setValue(
          this.plugin.settings.authorizationHeaderName ??
            DefaultBearerTokenHeaderName
        );
      });
      new Setting(containerEl).setName("Binding Host").addText((cb) => {
        cb.onChange((value) => {
          if (value !== DefaultBindingHost) {
            this.plugin.settings.bindingHost = value;
          } else {
            delete this.plugin.settings.bindingHost;
          }
          this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }).setValue(this.plugin.settings.bindingHost ?? DefaultBindingHost);
      });
    }
  }
}
