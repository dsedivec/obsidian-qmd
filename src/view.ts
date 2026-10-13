import {
  ItemView,
  Keymap,
  Scope,
  type App,
  type PaneType,
  type WorkspaceLeaf,
} from "obsidian";
import { QmdSearchError } from "./errors";
import type QmdSearchPlugin from "./main";
import { highlightSegments, type SearchResult } from "./results";
import type { SearchStatus } from "./search-service";
import {
  folderLabel,
  footerText,
  moveSelection,
  scorePercent,
  statusText,
} from "./view-model";

export const VIEW_TYPE = "qmd-search-view";

const STATUS_REFRESH_MS = 1_000;
const FOOTER_REFRESH_MS = 30_000;
const LINK_TEXT = { settings: "Settings", retry: "Retry" } as const;

/** The settings dialog, which Obsidian's type declarations leave out. */
type AppWithSettingsDialog = App & {
  setting: { open(): void; openTabById(id: string): void };
};

/**
 * The search pane. Everything a note or QMD supplies (title, folder, snippet, error text) reaches
 * the DOM as a text node; nothing here parses HTML or renders Markdown.
 */
export class SearchView extends ItemView {
  private readonly inputEl: HTMLInputElement;
  private readonly resultsEl: HTMLElement;
  private readonly footerEl: HTMLElement;
  /** The rows of the results on show, in order. Empty while the list shows a message or nothing. */
  private rowEls: HTMLElement[] = [];
  private selectedEl: HTMLElement | null = null;
  /** Counts searches, so that one overtaken by a newer search, or by the pane closing, is told apart. */
  private sequence = 0;
  private running: AbortController | null = null;
  /** The status line of the running search, and the timer that keeps its seconds current. */
  private progress: { el: HTMLElement; timer: number } | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: QmdSearchPlugin,
  ) {
    super(leaf);
    const root = this.contentEl.createDiv({ cls: "qmd-search-view" });
    this.inputEl = root
      .createDiv({ cls: "qmd-search-input-row" })
      .createEl("input", {
        cls: "qmd-search-input",
        type: "text",
        placeholder: "Search with QMD…",
        attr: { spellcheck: "false" },
      });
    this.resultsEl = root.createDiv({ cls: "qmd-search-results" });
    this.footerEl = root.createDiv({ cls: "qmd-search-footer" });

    this.inputEl.addEventListener("keydown", (evt) => this.onInputKey(evt));
    // Also reached with the mouse, which no key handler sees.
    this.inputEl.addEventListener("focus", () => this.select(null));

    // Obsidian's hotkey table binds Mod-Enter, with and without Alt and Shift, to editor commands,
    // and takes those keys before any element sees them. While the pane is active its own scope
    // is asked first. This handler claims Enter and does nothing, so the key reaches the row.
    this.scope = new Scope(this.app.scope);
    this.scope.register(null, "Enter", () => undefined);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "QMD Search";
  }

  getIcon(): string {
    return "search";
  }

  focusInput(): void {
    this.select(null);
    this.inputEl.focus();
    this.inputEl.select();
  }

  /** Searches for `text`, or for what the input holds. Never rejects: a failure is shown in the pane. */
  async runSearch(text?: string): Promise<void> {
    if (text !== undefined) this.inputEl.value = text;
    const query = this.inputEl.value.trim();
    if (query === "") return;

    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    const run = ++this.sequence;
    const showStatus = this.beginProgress();

    let results: SearchResult[] | null = null;
    let error: unknown = null;
    try {
      results = await this.plugin.search.search(query, {
        signal: controller.signal,
        onStatus: (status) => {
          if (run === this.sequence) showStatus(status);
        },
      });
    } catch (err) {
      error = err;
    }
    // A newer search, or the pane closing, has taken over: the pane is no longer this search's.
    if (run !== this.sequence) return;
    this.running = null;
    this.endProgress();
    if (error instanceof QmdSearchError && error.kind === "aborted") return;
    // A failure replaces the results: the ones on show answered another query.
    this.plugin.session = { query, results, error };
    this.renderSession();
  }

  protected async onOpen(): Promise<void> {
    this.inputEl.value = this.plugin.session.query;
    this.renderSession();
    this.unsubscribe = this.plugin.indexer.onChange(() => this.renderFooter());
    // "indexed 2 min ago" ages with nothing else to redraw it.
    this.registerInterval(
      window.setInterval(() => this.renderFooter(), FOOTER_REFRESH_MS),
    );
  }

  protected async onClose(): Promise<void> {
    this.sequence++;
    this.running?.abort();
    this.running = null;
    this.endProgress();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Dims the results and shows the status line. Returns the function that changes what it says. */
  private beginProgress(): (status: SearchStatus) => void {
    this.endProgress();
    const startedAt = Date.now();
    let status: SearchStatus = "searching";
    const el = createDiv({ cls: "qmd-search-status" });
    el.createSpan({ cls: "qmd-search-spinner" });
    const textEl = el.createSpan();
    const draw = (): void =>
      textEl.setText(statusText(status, Date.now() - startedAt));
    draw();
    this.resultsEl.before(el);
    this.resultsEl.addClass("is-stale");
    this.progress = { el, timer: window.setInterval(draw, STATUS_REFRESH_MS) };
    this.renderFooter();
    return (next) => {
      status = next;
      draw();
    };
  }

  private endProgress(): void {
    if (this.progress === null) return;
    window.clearInterval(this.progress.timer);
    this.progress.el.detach();
    this.progress = null;
    this.resultsEl.removeClass("is-stale");
    this.renderFooter();
  }

  private renderSession(): void {
    const { query, results, error } = this.plugin.session;
    // The rows are about to go. Focus on one of them would fall out of the pane.
    if (this.resultsEl.contains(this.resultsEl.ownerDocument.activeElement))
      this.inputEl.focus();
    this.resultsEl.empty();
    this.rowEls = [];
    this.selectedEl = null;
    if (error !== null) {
      this.renderError(error);
    } else if (results !== null && results.length === 0) {
      this.resultsEl.createDiv({
        cls: "qmd-search-message",
        text: "No results.",
      });
    } else if (results !== null) {
      this.rowEls = results.map((result, index) =>
        this.renderResult(result, index, query),
      );
    }
    this.renderFooter();
  }

  private renderResult(
    result: SearchResult,
    index: number,
    query: string,
  ): HTMLElement {
    const row = this.resultsEl.createDiv({
      cls: "qmd-search-result",
      attr: { tabindex: "-1" },
    });
    const head = row.createDiv({ cls: "qmd-search-result-head" });
    head.createDiv({ cls: "qmd-search-title", text: result.title });
    head.createDiv({
      cls: "qmd-search-score",
      text: scorePercent(result.score),
    });
    if (result.folder !== "")
      row.createDiv({
        cls: "qmd-search-folder",
        text: folderLabel(result.folder),
      });
    const snippet = row.createDiv({ cls: "qmd-search-snippet" });
    for (const segment of highlightSegments(result.snippet, query)) {
      if (segment.bold) snippet.createEl("strong", { text: segment.text });
      else snippet.appendText(segment.text);
    }

    row.addEventListener("click", (evt) => {
      this.select(row);
      this.openNote(result, { newLeaf: Keymap.isModEvent(evt), focus: true });
    });
    row.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        this.openNote(result, {
          newLeaf: Keymap.isModEvent(evt),
          focus: false,
        });
      } else if (evt.key === "ArrowUp" || evt.key === "ArrowDown") {
        evt.preventDefault();
        // `index` is this row's own place in the list, so the list is never empty here.
        const next = moveSelection(index, evt.key, this.rowEls.length);
        if (next === null) {
          this.select(null);
          this.inputEl.focus();
        } else {
          this.focusResult(next);
        }
      }
    });
    return row;
  }

  private renderError(error: unknown): void {
    const { message, detail, hint, links } = this.plugin.describe(error);
    const block = this.resultsEl.createDiv({ cls: "qmd-search-message" });
    block.createDiv({ cls: "qmd-search-error-message", text: message });
    if (detail)
      block.createEl("pre", { cls: "qmd-search-error-detail", text: detail });
    if (hint) block.createDiv({ cls: "qmd-search-error-hint", text: hint });
    for (const link of links) {
      const linkEl = block.createEl("a", {
        cls: "qmd-search-link",
        text: LINK_TEXT[link],
      });
      linkEl.addEventListener("click", () => {
        if (link === "settings") this.openSettings();
        else void this.runSearch();
      });
    }
  }

  private renderFooter(): void {
    // A count describes results that are current, and none are while a search is replacing them.
    const count =
      this.progress === null
        ? (this.plugin.session.results?.length ?? null)
        : null;
    const { text, error } = footerText(
      count,
      this.plugin.indexer.getState(),
      Date.now(),
    );
    this.footerEl.setText(text);
    this.footerEl.toggleClass("is-error", error);
  }

  private onInputKey(evt: KeyboardEvent): void {
    // Enter that confirms an input-method composition is not a search.
    if (evt.isComposing) return;
    if (evt.key === "Enter") {
      evt.preventDefault();
      void this.runSearch();
    } else if (evt.key === "ArrowDown") {
      const first = moveSelection(null, evt.key, this.rowEls.length);
      if (first === null) return;
      evt.preventDefault();
      this.focusResult(first);
    }
  }

  private focusResult(index: number): void {
    const row = this.rowEls[index];
    this.select(row);
    row.focus();
  }

  private select(row: HTMLElement | null): void {
    this.selectedEl?.removeClass("is-selected");
    this.selectedEl = row;
    row?.addClass("is-selected");
  }

  /** Not named `open`: Obsidian's View has a method of that name, which its type declarations leave out. */
  private openNote(
    result: SearchResult,
    opts: { newLeaf: PaneType | boolean; focus: boolean },
  ): void {
    this.plugin
      .openResult(result, opts)
      .then(() => {
        // With "Always focus new tabs" on, Obsidian makes a new tab the active leaf, and then no
        // longer asks the pane's scope about keys. A note opened from the keyboard leaves the pane
        // active, as it leaves the focus on the row.
        if (!opts.focus)
          this.app.workspace.setActiveLeaf(this.leaf, { focus: false });
      })
      .catch((err: unknown) =>
        console.error("QMD Search: could not open the note", err),
      );
  }

  private openSettings(): void {
    const { setting } = this.app as AppWithSettingsDialog;
    setting.open();
    setting.openTabById(this.plugin.manifest.id);
  }
}
