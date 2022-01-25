import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { v4 as uuidv4 } from 'uuid';
import * as hash from 'hash.js'
import express from 'express'
import * as http from 'http'

// Remember to rename these classes and interfaces!

interface Settings {
  apiKey?: string;
  port: number;
}

const DEFAULT_SETTINGS: Settings = {
  port: 27124
}

export default class MyPlugin extends Plugin {
  settings: Settings;
  server: http.Server | null = null; 

  async onload() {
    await this.loadSettings();

    if (!this.settings.apiKey) {
      this.settings.apiKey = hash.sha224().update(uuidv4()).digest('hex')
    }

    this.addSettingTab(new SampleSettingTab(this.app, this));
    
    this.refreshServerState()
  }

  refreshServerState() {
    if(this.server) {
      this.server.close()
    }

    const app = express()
    this.server = app.listen(this.settings.port)

	  console.log(`REST API listening on ${this.settings.port}`)
  }

  onunload() {
    if(this.server) {
      this.server.close()
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
    const {containerEl} = this;

    containerEl.empty();
    containerEl.classList.add('obsidian-rest-api-settings')

    const apiKeyDiv = containerEl.createEl('div')
    apiKeyDiv.classList.add('api-key-display')

    apiKeyDiv.createEl("h3", { text: "Your API Key" });
    apiKeyDiv.createEl("p", {text: "This must be passed in all requests via an authorization header."})
    apiKeyDiv.createEl("div", {text: this.plugin.settings.apiKey})
    apiKeyDiv.createEl("p", {text: "Example header: "})
    apiKeyDiv.createEl("div", {text: `Authorization: Token ${this.plugin.settings.apiKey}`})

    new Setting(containerEl)
        .setName("Server Port")
        .addText(cb => cb.onChange(value => {
            this.plugin.settings.port = parseInt(value, 10)
            this.plugin.saveSettings()
            this.plugin.refreshServerState()
        }).setValue(this.plugin.settings.port.toString()))
  }
}
