import { realpathSync } from "node:fs";
import { Notice, Plugin, TFile, type FileSystemAdapter, type TAbstractFile } from "obsidian";
import { CLI_COMMAND, CLI_DESCRIPTION, CLI_FLAGS, createCliHandler } from "./cli-handler";
import { sanitizeSettings, type KeyValueStore, type QmdSearchSettings } from "./config";
import { describeError, type ErrorView } from "./errors";
import { createExclusionCheck } from "./exclusions";
import { Indexer } from "./indexer";
import { QmdCli } from "./qmd-cli";
import { QmdClient } from "./qmd-client";
import type { SearchResult } from "./results";
import { SearchService } from "./search-service";
import { createServerDeps } from "./server-deps";
import { ServerManager } from "./server-manager";
import { QmdSearchSettingTab } from "./settings";

/** A value may be as raw as the text of a settings field: every one is sanitised before it becomes a setting. */
type SettingsPatch = { [K in keyof QmdSearchSettings]?: unknown };

/** Runs one step and logs a throw, so that a failing step never skips the ones after it. */
function attempt(what: string, step: () => void): void {
  try {
    step();
  } catch (err) {
    console.error(`QMD Search: could not ${what}`, err);
  }
}

function isNote(file: TAbstractFile): boolean {
  return file instanceof TFile && file.extension === "md";
}

export default class QmdSearchPlugin extends Plugin {
  /**
   * Replaced only by `updateSettings`, so nothing ever reads a half-typed value. `declare`, because
   * Obsidian's `Plugin` has had the property itself since 1.13.0.
   */
  declare settings: QmdSearchSettings;
  cli!: QmdCli;
  server!: ServerManager;
  indexer!: Indexer;
  search!: SearchService;
  /** The last search, kept here so that it outlives the pane. */
  session: { query: string; results: SearchResult[] | null; error: unknown } = { query: "", results: null, error: null };
  private stopped = false;

  async onload(): Promise<void> {
    const saved: unknown = await this.loadData();
    this.settings = sanitizeSettings(saved, this.app.vault.getName());
    if (JSON.stringify(saved) !== JSON.stringify(this.settings)) await this.saveData(this.settings);
    // The plugin can unload while the settings load or save. Nothing registered after that would
    // ever be removed again, and a CLI command left registered makes the next load throw.
    if (this.stopped) return;

    const getSettings = (): QmdSearchSettings => this.settings;
    const store: KeyValueStore = {
      get: (key) => this.app.loadLocalStorage(key),
      set: (key, value) => this.app.saveLocalStorage(key, value),
    };
    this.cli = new QmdCli(getSettings);
    this.server = new ServerManager(createServerDeps({ cli: this.cli, getSettings, store }));
    this.indexer = new Indexer({
      cli: this.cli,
      getSettings,
      vaultPath: (this.app.vault.adapter as FileSystemAdapter).getBasePath(),
      realpath: realpathSync,
      store,
      now: Date.now,
    });
    this.search = new SearchService({
      indexer: this.indexer,
      server: this.server,
      client: new QmdClient(() => this.settings.port),
      getSettings,
      fileExists: (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
      isExcluded: createExclusionCheck(this.app),
    });

    this.addSettingTab(new QmdSearchSettingTab(this.app, this));
    this.addCommand({ id: "reindex", name: "Reindex vault now", callback: () => this.reindex() });
    this.registerCliHandler(
      CLI_COMMAND,
      CLI_DESCRIPTION,
      CLI_FLAGS,
      createCliHandler({
        search: (text, limit) => this.search.search(text, { limit }),
        getDefaultLimit: () => this.settings.resultCount,
        describe: (err) => {
          const { message, hint } = this.describe(err);
          return hint ? `${message} ${hint}` : message;
        },
      }),
    );
    this.registerDomEvent(window, "beforeunload", () => this.shutdown());

    // Inside onLayoutReady, so that the `create` events of the vault loading are not counted.
    this.app.workspace.onLayoutReady(async () => {
      try {
        await this.server.adoptIfOurs();
      } catch (err) {
        // Indexing must still start: a search waits for the indexer's first check.
        console.error("QMD Search: could not check for a QMD server left running", err);
      }
      // The plugin can unload before the layout is ready, or while the check above waits.
      if (this.stopped) return;
      const { vault } = this.app;
      const noteChanged = (file: TAbstractFile): void => {
        if (isNote(file)) this.indexer.markDirty();
      };
      this.registerEvent(vault.on("create", noteChanged));
      this.registerEvent(vault.on("modify", noteChanged));
      this.registerEvent(vault.on("delete", noteChanged));
      this.registerEvent(
        vault.on("rename", (file, oldPath) => {
          if (isNote(file) || oldPath.endsWith(".md")) this.indexer.markDirty();
        }),
      );
      void this.indexer.start();
    });
  }

  onunload(): void {
    this.shutdown();
  }

  async updateSettings(patch: SettingsPatch): Promise<void> {
    const before = this.settings;
    const after = sanitizeSettings({ ...before, ...patch }, this.app.vault.getName());
    this.settings = after;
    // Acted on before the save is awaited, so that no search can start a server from the new
    // settings in between and have it stopped here.
    if (after.port !== before.port || after.qmdPath !== before.qmdPath || after.extraPath !== before.extraPath) {
      attempt("stop the QMD server", () => this.server.stopIfOwned());
    }
    if (after.collectionName !== before.collectionName) void this.indexer.start();
    await this.saveData(after);
  }

  /** `describeError` with the current QMD path and port. */
  describe(err: unknown): ErrorView {
    return describeError(err, this.settings);
  }

  private async reindex(): Promise<void> {
    await this.indexer.runNow();
    const state = this.indexer.getState();
    if (state.kind === "failed") new Notice(`QMD: index failed: ${state.message}`);
    // Still `running` means the run was cut off by the plugin unloading: nothing was reindexed.
    else if (state.kind === "idle") new Notice("QMD: vault reindexed.");
  }

  /**
   * Runs when the plugin unloads and when the window closes, and both can happen. Every step is
   * safe to repeat, and each has its own guard so that one failing never skips the rest.
   */
  private shutdown(): void {
    this.stopped = true;
    // Nothing to stop if onload failed before it built the units.
    if (!this.search) return;
    attempt("stop the QMD server", () => this.server.stopIfOwned());
    attempt("stop the running qmd commands", () => this.cli.killAll());
    attempt("stop the indexer", () => this.indexer.dispose());
    attempt("shut down the server manager", () => this.server.dispose());
  }
}
