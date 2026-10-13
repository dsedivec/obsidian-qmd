import { PluginSettingTab, Setting, type App } from "obsidian";
import type { QmdSearchSettings } from "./config";
import type QmdSearchPlugin from "./main";

const FIELDS: ReadonlyArray<{
  key: keyof QmdSearchSettings;
  name: string;
  description: string;
}> = [
  {
    key: "qmdPath",
    name: "QMD path",
    description: "Path to the qmd executable.",
  },
  {
    key: "extraPath",
    name: "Extra PATH directories",
    description:
      "Colon-separated directories added to PATH when running qmd, so it can find node.",
  },
  {
    key: "collectionName",
    name: "Collection name",
    description:
      "QMD collection for this vault. Letters, digits, - and _ only, and it cannot start with -.",
  },
  {
    key: "port",
    name: "Server port",
    description:
      "Port for the QMD server. A server already running there is used and left running.",
  },
  {
    key: "idleTimeoutMinutes",
    name: "Idle timeout (minutes)",
    description:
      "Stop the QMD server this plugin started after this long without a search.",
  },
  {
    key: "reindexQuietMinutes",
    name: "Reindex quiet period (minutes)",
    description: "Reindex this long after the last change to a note.",
  },
  {
    key: "resultCount",
    name: "Result count",
    description: "Results to show, 1 to 50.",
  },
];

export class QmdSearchSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: QmdSearchPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    for (const { key, name, description } of FIELDS) {
      new Setting(this.containerEl)
        .setName(name)
        .setDesc(description)
        .addText((text) => {
          const showSaved = (): void =>
            void text.setValue(String(this.plugin.settings[key]));
          showSaved();
          // The DOM `change` event fires on blur or Enter. A keystroke changes nothing: a half-typed
          // collection name must never reach the settings, where the indexer would act on it.
          text.inputEl.addEventListener("change", () => {
            this.plugin
              .updateSettings({ [key]: text.inputEl.value })
              .catch((err: unknown) =>
                console.error("QMD Search: could not save the settings", err),
              )
              .then(showSaved);
          });
        });
    }
  }
}
