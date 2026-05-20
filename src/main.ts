import { App, Plugin } from "obsidian";
import * as https from "https";
import * as http from "http";
import forge, { pki } from "node-forge";

import RequestHandler from "./requestHandler";
import { LocalRestApiSettings } from "./types";

import {
  DEFAULT_SETTINGS,
  DefaultBindingHost,
} from "./constants";
import LocalRestApiPublicApi, { ApiVersionUnsupportedError } from "./api";
import { LocalRestApiSettingTab } from "./settings";
export { ApiVersionUnsupportedError } from "./api";
import { PluginManifest } from "obsidian";

export default class LocalRestApi extends Plugin {
  settings!: LocalRestApiSettings;
  secureServer: https.Server | null = null;
  insecureServer: http.Server | null = null;
  requestHandler!: RequestHandler;
  refreshServerState!: () => void;

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
      this.secureServer.listen(
        this.settings.port,
        this.settings.bindingHost ?? DefaultBindingHost
      );

      if (this.settings.enableVerboseLogging) {
        console.debug(
          `[REST API] Listening on https://${this.settings.bindingHost ?? DefaultBindingHost
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
      this.insecureServer.listen(
        this.settings.insecurePort,
        this.settings.bindingHost ?? DefaultBindingHost
      );

      if (this.settings.enableVerboseLogging) {
        console.debug(
          `[REST API] Listening on http://${this.settings.bindingHost ?? DefaultBindingHost
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
