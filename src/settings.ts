import { PluginSettingTab, Setting, type App } from "obsidian";
import type { QmdSearchSettings } from "./config";
import type QmdSearchPlugin from "./main";
import { checkQmd, qmdCheckText } from "./qmd-check";
import { serverStatusText } from "./view-model";

const FIELDS: ReadonlyArray<{
  key: keyof QmdSearchSettings;
  name: string;
  description: string;
}> = [
  {
    key: "qmdPath",
    name: "QMD path",
    description: "Path to the qmd executable. A leading ~ is your home folder.",
  },
  {
    key: "extraPath",
    name: "Extra PATH directories",
    description:
      "Colon-separated directories added to PATH when running qmd, so it can find node. A leading ~ is your home folder.",
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

/** How often the server's status is read again while the tab is open. */
const STATUS_REFRESH_MS = 3000;

export class QmdSearchSettingTab extends PluginSettingTab {
  private statusTimer: number | undefined;

  constructor(
    app: App,
    private readonly plugin: QmdSearchPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    // Obsidian can call this again while the tab is showing.
    this.stopStatus();
    this.containerEl.empty();
    let clearTest = (): void => {};
    for (const { key, name, description } of FIELDS) {
      const setting = new Setting(this.containerEl)
        .setName(name)
        .setDesc(description);
      let commit: () => Promise<void> = () => Promise.resolve();
      setting.addText((text) => {
        const showSaved = (): void =>
          void text.setValue(String(this.plugin.settings[key]));
        showSaved();
        commit = () =>
          this.plugin
            .updateSettings({ [key]: text.inputEl.value })
            .catch((err: unknown) =>
              console.error("QMD Search: could not save the settings", err),
            )
            .then(showSaved);
        // The DOM `change` event fires on blur or Enter. A keystroke changes nothing: a half-typed
        // collection name must never reach the settings, where the indexer would act on it.
        text.inputEl.addEventListener("change", () => {
          // What the last test found was about the command as it was before this change.
          if (key === "qmdPath" || key === "extraPath") clearTest();
          void commit();
        });
      });
      if (key === "qmdPath") clearTest = this.addTest(setting, () => commit());
      if (key === "port") this.addServerStatus();
    }
  }

  hide(): void {
    this.stopStatus();
    super.hide();
  }

  /**
   * A button that runs `qmd --version` with the settings as they are, and says what came of it.
   * Returns the function that takes that line away again, for when the command it was about
   * changes.
   */
  private addTest(setting: Setting, commit: () => Promise<void>): () => void {
    const resultEl = setting.descEl.createDiv({
      cls: "qmd-search-setting-result",
    });
    // Counts the tests and the clearings, so that a test overtaken by either shows nothing.
    let latest = 0;
    const show = (text: string, cls?: "is-ok" | "is-error"): void => {
      resultEl.removeClass("is-ok", "is-error");
      resultEl.setText(text);
      if (cls) resultEl.addClass(cls);
    };
    setting.addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        const mine = ++latest;
        button.setDisabled(true);
        show("Testing…");
        try {
          // What is in the box is saved first, so that it is what gets tested.
          await commit();
          const { qmdPath } = this.plugin.effectiveSettings();
          const { text, ok } = qmdCheckText(
            await checkQmd(this.plugin.cli),
            qmdPath,
          );
          if (mine === latest) show(text, ok ? "is-ok" : "is-error");
        } catch (err) {
          console.error("QMD Search: could not test the QMD path", err);
          if (mine === latest) show("The test could not be run.", "is-error");
        } finally {
          button.setDisabled(false);
        }
      }),
    );
    return () => {
      latest++;
      show("");
    };
  }

  /** A line that says how the QMD server stands, read again every few seconds while the tab is open. */
  private addServerStatus(): void {
    const setting = new Setting(this.containerEl)
      .setName("QMD server")
      .setDesc("Checking…");
    let reading = false;
    const refresh = async (): Promise<void> => {
      if (reading) return;
      reading = true;
      try {
        setting.setDesc(serverStatusText(await this.plugin.server.status()));
      } catch (err) {
        console.error("QMD Search: could not read the server's status", err);
      } finally {
        reading = false;
      }
    };
    void refresh();
    this.statusTimer = this.plugin.registerInterval(
      window.setInterval(() => void refresh(), STATUS_REFRESH_MS),
    );
  }

  private stopStatus(): void {
    window.clearInterval(this.statusTimer);
    this.statusTimer = undefined;
  }
}
