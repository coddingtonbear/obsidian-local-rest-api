import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import express from "express";
import * as https from "https";
import forge, { pki } from "node-forge";

import setupServer from './server'

// Remember to rename these classes and interfaces!

interface Settings {
  apiKey?: string;
  crypto?: {
    cert: string;
    privateKey: string;
    publicKey: string;
  };
  port: number;
}

const DEFAULT_SETTINGS: Settings = {
  port: 27124,
};

export default class MyPlugin extends Plugin {
  settings: Settings;
  server: https.Server | null = null;
  expressApp: express.Express;

  async onload() {
    await this.loadSettings();
    this.expressApp = express()
    setupServer(this.expressApp)

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
      const certificate = forge.pki.createCertificate();
      certificate.publicKey = keypair.publicKey;
      certificate.validity.notAfter = expiry;
      certificate.validity.notBefore = today;
      certificate.sign(keypair.privateKey);

      this.settings.crypto = {
        cert: pki.certificateToPem(certificate),
        privateKey: pki.privateKeyToPem(keypair.privateKey),
        publicKey: pki.publicKeyToPem(keypair.publicKey),
      };
      this.saveSettings();
    }

    this.addSettingTab(new SampleSettingTab(this.app, this));

    this.refreshServerState();
  }

  refreshServerState() {
    if (this.server) {
      this.server.close();
    }
    this.server = https.createServer(
      { key: this.settings.crypto.privateKey, cert: this.settings.crypto.cert },
      this.expressApp
    );
    this.server.listen(this.settings.port);

    console.log(`REST API listening on ${this.settings.port}`);
  }

  onunload() {
    if (this.server) {
      this.server.close();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class SampleSettingTab extends PluginSettingTab {
  plugin: MyPlugin;

  constructor(app: App, plugin: MyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();
    containerEl.classList.add("obsidian-rest-api-settings");

    const apiKeyDiv = containerEl.createEl("div");
    apiKeyDiv.classList.add("api-key-display");

    apiKeyDiv.createEl("h3", { text: "Your API Key" });
    apiKeyDiv.createEl("p", {
      text: "This must be passed in all requests via an authorization header.",
    });
    apiKeyDiv.createEl("div", { text: this.plugin.settings.apiKey });
    apiKeyDiv.createEl("p", { text: "Example header: " });
    apiKeyDiv.createEl("div", {
      text: `Authorization: Token ${this.plugin.settings.apiKey}`,
    });

    new Setting(containerEl).setName("Server Port").addText((cb) =>
      cb
        .onChange((value) => {
          this.plugin.settings.port = parseInt(value, 10);
          this.plugin.saveSettings();
          this.plugin.refreshServerState();
        })
        .setValue(this.plugin.settings.port.toString())
    );
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
