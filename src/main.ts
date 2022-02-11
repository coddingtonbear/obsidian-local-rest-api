import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import * as https from "https";
import * as http from "http";
import forge, { pki } from "node-forge";

import RequestHandler from "./requestHandler";
import { LocalRestApiSettings } from "./types";

import { CERT_NAME, DEFAULT_SETTINGS, HOSTNAME } from "./constants";

export default class LocalRestApi extends Plugin {
  settings: LocalRestApiSettings;
  httpsServer: https.Server | null = null;
  httpServer: http.Server | null = null;
  requestHandler: RequestHandler;

  async onload() {
    await this.loadSettings();
    this.requestHandler = new RequestHandler(
      this.app,
      this.manifest,
      this.settings
    );
    this.requestHandler.setupRouter();

    this.app;

    if (this.settings.crypto && this.settings.crypto.resetOnNextLoad) {
      delete this.settings.apiKey;
      delete this.settings.crypto;
      this.saveSettings();
    }

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
              ip: HOSTNAME,
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

  refreshServerState() {
    if (this.httpsServer) {
      this.httpsServer.close();
      this.httpsServer = null;
    }
    this.httpsServer = https.createServer(
      { key: this.settings.crypto.privateKey, cert: this.settings.crypto.cert },
      this.requestHandler.api
    );
    this.httpsServer.listen(this.settings.port, HOSTNAME);

    console.log(
      `REST API listening on https://${HOSTNAME}/${this.settings.port}`
    );

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    if (this.settings.enableInsecureServer) {
      this.httpServer = http.createServer(this.requestHandler.api);
      this.httpServer.listen(this.settings.insecurePort, HOSTNAME);

      console.log(
        `REST API listening on http://${HOSTNAME}/${this.settings.insecurePort}`
      );
    }
  }

  onunload() {
    if (this.httpsServer) {
      this.httpsServer.close();
    }
    if (this.httpServer) {
      this.httpServer.close();
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
      text: `Authorization: Bearer ${this.plugin.settings.apiKey}`,
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
      .setName("Secure HTTPS Server Port")
      .setDesc(
        "This configures the port on which your REST API will listen for HTTPS connections.  It's recommended that you leave this port at its default as integrating tools may expect the default port.  In no circumstance is it recommended that you expose this service directly to the internet."
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
      .setName("Enable Insecure HTTP Server")
      .setDesc(
        "Enables an insecure HTTP server on the port designated below.  By default, this plugin requires a secure HTTPS connection, but in secure environments you may turn on the insecure server to simplify interacting with the API.  In no circumstances is it recommended that you expose this service to the internet, especially if you turn on this feature!"
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
      .setName("Insecure HTTP Server Port")
      .addText((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.port = parseInt(value, 10);
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.insecurePort.toString())
      );

    containerEl.createEl("hr");
    containerEl.createEl("h3", {
      text: "HTTPs Certificate Settings",
    });
    containerEl.createEl("p", {
      text: `The following are your Local REST API's public key, certificate, and private key.  These are automatically generated the first time this plugin is loaded, but you can update them to use keys you have generated if you would like to do so.`,
    });

    new Setting(containerEl)
      .setName("Reset Crypto on next Load")
      .setDesc(
        "Turning this toggle 'on' will cause your certificates and api key to be regenerated when this plugin is next loaded.  You can force a reload by running the 'Reload app without saving' command from the command palette, closing and re-opening Obsidian, or turning this plugin off and on again from the community plugins panel in Obsidian's settings."
      )
      .addToggle((value) => {
        value
          .onChange((value) => {
            this.plugin.settings.crypto.resetOnNextLoad = value;
            this.plugin.saveSettings();
          })
          .setValue(this.plugin.settings.crypto.resetOnNextLoad);
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
          this.plugin.settings.crypto.privateKey = value;
          this.plugin.saveSettings();
          this.plugin.refreshServerState();
        })
        .setValue(this.plugin.settings.crypto.privateKey)
    );
  }
}
