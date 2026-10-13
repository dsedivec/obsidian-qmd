# QMD Search

QMD Search is an Obsidian plugin that searches a vault with [QMD][qmd]'s hybrid
search. It keeps the vault indexed in QMD on its own, and shows the results of
`qmd query` (query expansion, hybrid retrieval and reranking) in a compact
sidebar pane. Scripts and agents can run the same search through the Obsidian
CLI.

## Requirements

- [QMD][qmd]. The plugin is built and tested against QMD 2.8.3.
- `node`, which QMD runs on, in one of the plugin's "Extra PATH directories", in
  the folder of the "QMD path", or in a folder already on Obsidian's `PATH`.
- Obsidian 1.12.2 or later, on the desktop.
- macOS or Linux. The plugin is developed and tested on macOS. Windows and
  mobile are not supported.

## Installing with BRAT

[BRAT][brat] is an Obsidian plugin that installs other plugins from their GitHub
releases and keeps them up to date. To install QMD Search with it:

1. Install "BRAT" from Settings → Community plugins, and turn it on.
2. Run the command "BRAT: Plugins: Add a beta plugin for testing (with or
   without version)".
3. Under "Repository", enter `https://github.com/dsedivec/obsidian-qmd`. Under
   "Select a version", choose "Latest version".
4. Leave "Enable after installing the plugin" ticked, and choose "Add plugin".
5. Set the QMD path, as [Setting the QMD path](#setting-the-qmd-path) describes.

BRAT installs the newest release of the repository, so the repository has to
have one: see [Publishing a release](#publishing-a-release). When a newer
release is out, the command "BRAT: Plugins: Check for updates to all beta
plugins and UPDATE" installs it. So does starting Obsidian, if BRAT's
"Auto-update plugins at startup" setting is on.

## Building and installing from a checkout

The plugin can also be built and installed from a checkout of this repository:

```sh
make setup
make build
make install-plugin VAULT="/path/to/your vault"
```

`make setup` installs the npm packages and the Git hooks, so it needs npm and
[prek][prek]. If you only want to build the plugin, `npm install` does in its
place. `make build` typechecks the code and writes `main.js`.
`make install-plugin` copies `main.js`, `manifest.json` and `styles.css` into
the vault's `.obsidian/plugins/qmd-search` folder. It refuses a folder that is
not a vault. It also refuses the vault at `/Users/alex/Documents/Obsidian/Main`,
which takes running the script itself with `--allow-main`:

```sh
node scripts/install-plugin.mjs /Users/alex/Documents/Obsidian/Main --allow-main
```

Then, in Obsidian, turn on "QMD Search" under Settings → Community plugins.
After a later `make install-plugin`, turn the plugin off and on again to load
the new build.

## Setting the QMD path

Check the "QMD path" setting before your first search. The default, `qmd`, is
found only if `qmd` is in one of the "Extra PATH directories" or in a folder
already on Obsidian's `PATH`, and Obsidian does not inherit your shell's `PATH`
when it is started from the Dock. When `qmd` is not found, the pane says
`Index failed: Couldn't run qmd at "qmd".` Enter the full path that `which qmd`
prints in a terminal. A leading `~` stands for your home folder, so
`~/.npm-packages/bin/qmd` works. The plugin runs `qmd` with a `PATH` made of
that path's folder, then the "Extra PATH directories", then Obsidian's own
`PATH`. If `node` is in none of those, add its folder to "Extra PATH
directories".

The "Test" button beside the field tells you whether the path is right. It runs
`qmd --version` just as the plugin would run `qmd`, and answers
`Found QMD 2.8.3.` when all is well.

## Settings

| Setting                        | Default                            | Notes                                                                                                                                                      |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QMD path                       | `qmd`                              | The `qmd` executable. A bare name is looked up on the `PATH` described above. A leading `~` is your home folder.                                           |
| Extra PATH directories         | `/opt/homebrew/bin:/usr/local/bin` | Folders, separated by colons, that are added to `PATH` when the plugin runs `qmd`, so that it finds `node`. A leading `~` in a folder is your home folder. |
| Collection name                | made from the vault's name         | The QMD collection for this vault. Letters, digits, `-` and `_` only, and it cannot start with `-`.                                                        |
| Server port                    | `8181`                             | The port of the QMD server, from 1 to 65535. 8181 is QMD's own default.                                                                                    |
| Idle timeout (minutes)         | `60`                               | How long after the last search the plugin stops a server it started. 1 to 1440.                                                                            |
| Reindex quiet period (minutes) | `5`                                | How long after the last change to a note the plugin reindexes the vault. 1 to 120.                                                                         |
| Result count                   | `10`                               | How many results a search shows. 1 to 50.                                                                                                                  |

A field is saved when you press Enter in it or leave it, and a change takes
effect at the next search or index run. A value that cannot be used is not
saved, and the field goes back to the previous value: a number field that is
empty or holds text, a port outside 1 to 65535, an empty QMD path, or a
collection name that breaks the rule. A number that is merely out of its range
becomes the nearest value allowed. "Extra PATH directories" may be left empty.

- The collection name is made from the vault's name the first time the plugin
  loads, and renaming the vault later does not change it. A name that breaks the
  rule is refused, and the name in use is kept.
- Changing the collection name makes the plugin create the new collection if it
  is missing. The old one is left as it is.
- Changing the port, the QMD path or the extra PATH directories stops a server
  that the plugin started.
- A leading `~` is the only thing expanded in the two path settings: `~` alone,
  or `~/` and what follows. `~name` for another user, a `~` further into a path,
  and variables such as `$HOME` are left as they are. The setting keeps the `~`
  as you typed it.

The settings tab also has two things that are not settings:

- **Test**, beside the QMD path, saves what is in the field and runs
  `qmd --version` with the settings as they are. It reads no index and starts no
  server. Under the field it then says one of these: `Found QMD` and the
  version; that the file could not be run; that `qmd` started but failed, with
  the first line it printed, and a hint when `node` was not found; that the
  program ran but does not look like QMD; or that it did not answer within 15
  seconds.
- **QMD server**, under the server port, says how the server stands. It is read
  again every three seconds while the tab is open. It says that the server is
  not running, that it is starting, that it is running and this plugin started
  it (with its process ID), that this plugin started it but it is not answering,
  or that it is running and something else started it. The last is also what a
  second vault shows while it shares the server that the first vault started.

## Commands

- **Search** shows the search pane, opening it in the right sidebar if it is not
  open, and puts the cursor in its search box. It has no hotkey until you give
  it one under Settings → Hotkeys.
- **Reindex vault now** runs the indexer at once, and shows a notice when it has
  finished or failed.

In the pane, Enter runs the search. Down moves from the search box into the
results, and Up and Down move between them. Enter opens the selected note at the
matching line, and Cmd-Enter (Ctrl-Enter on Linux) opens it in a new tab. A
click and a Cmd-click do the same. Notes that Obsidian's "Excluded files"
setting covers are left out of the results.

## Obsidian CLI

The plugin adds a `qmd-search` subcommand to the Obsidian CLI. It runs the same
search as the pane, with the same settings, exclusions and server. The Obsidian
app must be running with the vault open, and Obsidian's command-line interface
must be enabled.

```sh
obsidian vault="Notes" qmd-search query="pod identity" limit=1
```

```text
Projects/Platform/EKS plan.md:42  (88%)
  Move workloads off node instance profiles so each pod gets only the access it needs.
```

| Flag           | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `query=<text>` | Required. The search text.                                              |
| `limit=<n>`    | A whole number from 1 to 50. The default is the "Result count" setting. |
| `json`         | Print a JSON array of the results in place of the text.                 |

Each result is printed as its path and line, its score, and a snippet. A JSON
result holds `path`, `title`, `folder`, `line`, `score` (from 0 to 1) and
`snippet`. With no results the command prints `No results.`, or `[]` with
`json`. A failure is printed as a line that starts with `Error:`, and the CLI
exits with status 0 either way.

Run the command with a timeout. The Obsidian CLI has no time limit of its own,
and a `qmd-search` call that is in flight when its vault's window closes never
returns. Scripts and agents should wrap it:

```sh
timeout -k 5 200 obsidian vault="Notes" qmd-search query="…"
```

That stops the CLI after 200 seconds, and kills it 5 seconds later if it is
still running. Stock macOS has no `timeout`. It comes with GNU coreutils, as
`gtimeout` unless the unprefixed tools are installed.

## The QMD server

A search goes to a QMD HTTP server, which keeps QMD's models loaded from one
search to the next.

- **Starting.** If no QMD server answers on the "Server port" when you search,
  the plugin starts one with `qmd mcp --http --port <port>`. The pane says
  "Starting QMD server…" while it waits. The plugin runs `qmd` from `/`, and not
  from the folder Obsidian was started in, so that it always uses QMD's global
  index and never the index of a project around that folder.
- **Sharing.** A QMD server that already answers on that port is used as it is,
  and the plugin never stops it. That includes one you started yourself with
  `qmd mcp --http`, whose default port, 8181, is the plugin's too. Two vaults
  open at once share one server: the second uses the server that the first
  started, and starts its own at its next search if the first has stopped it.
- **Seeing which.** The "QMD server" line in the settings tab says whether a
  server is running, and whether this plugin started it.
- **Stopping.** The plugin stops only a server that it started. It does so after
  the idle timeout has passed without a search, when the plugin is turned off,
  when the vault's window closes or Obsidian quits, and when the port, the QMD
  path or the extra PATH directories setting changes. If Obsidian crashes and
  leaves the server running, the plugin finds it at the next start, and either
  goes on using it or stops it.

One case is known in which a server the plugin started is left running. The
plugin stops a server by asking it to stop, and kills it five seconds later if
it is still there. A server that does not act on the request, because it has
stopped responding, is left running if the vault's window closes or Obsidian
quits before those five seconds are up. That is so whether the window closing
was itself the reason for the request, or the plugin had made it less than five
seconds earlier for any other reason: the idle timeout, a settings change,
replacing a server that had stopped answering, or stopping one that an earlier
session left behind. `pgrep -fl "mcp --http --port 8181"` lists such a server,
and it has to be killed by hand.

## Models

QMD searches with three local models, about 2 GB in all. The plugin never
downloads or refreshes them on its own, and it never runs `qmd pull`. QMD
fetches a model that is missing when it first needs it: the embedding model
during the first index run, and the other two during the first search that needs
them. On a machine that does not have the models yet, that first search is
therefore slow, and it may fail after two minutes with the hint "If QMD is still
downloading its models, try again in a few minutes."

You can run `qmd pull` by hand to fetch the models beforehand. In QMD 2.8.3 it
checks each model against huggingface.co, and it deletes the cached copy and
downloads it again whenever that check fails. Offline, the check fails and the
deleted model is not restored. That is why the plugin leaves `qmd pull` to you.

## Server log

A server that the plugin starts writes its output to
`$TMPDIR/qmd-search-server-<port>.log`, which is `qmd-search-server-8181.log`
with the default port. On Linux `$TMPDIR` is often unset, and the log is then
under `/tmp`. The log contains the text of your queries. The plugin creates it
readable by your user only, and replaces it each time it starts a server. When a
server fails to start, the pane shows the last lines of this log.

## The index and its collection

The plugin keeps the vault in a collection of QMD's default index, named by the
"Collection name" setting, so `qmd` on the command line can search the vault
too. It reindexes after notes have changed and the quiet period has passed, and
once after it loads, to catch up on changes made while Obsidian was closed. A
reindex runs `qmd update`, which scans every collection in the index and not
only the vault's, and then `qmd embed` for the vault's collection. Until the
first index run in a vault has finished, a search answers "The vault is still
being indexed for the first time."

The plugin creates the vault's collection when it is missing. It never removes,
renames or edits a collection, so one is left behind when you change the
collection name or stop using the plugin. To remove it:

```sh
qmd collection list
qmd collection remove <name>
```

If the name already belongs to a collection that points at another folder, the
plugin leaves that collection alone and reports
`Index failed: collection "<name>" points at another folder`. Choose another
name.

## Development

`make help` lists the commands. `AGENTS.md` holds the conventions and the rules
that a change to this plugin must keep.

### Publishing a release

BRAT installs the plugin from a GitHub release of
`github.com/dsedivec/obsidian-qmd`. A release is tagged with the plugin's
version, with no `v` in front, and has `main.js`, `manifest.json` and
`styles.css` attached.

1. Set the new version in `manifest.json` and `package.json`, and commit.
2. Push the default branch. The release is made from its head.
3. Build the plugin and create the release with the [GitHub CLI][gh]:

```sh
make build
version=$(node -p 'require("./manifest.json").version')
gh release create "$version" main.js manifest.json styles.css \
  --title "$version" --generate-notes
```

`gh release create` makes the tag on GitHub if it is not there yet. Keep the tag
and the `version` in the attached `manifest.json` the same: BRAT goes by the
tag, and warns when the manifest disagrees with it.

[qmd]: https://github.com/tobi/qmd
[prek]: https://prek.j178.dev/
[brat]: https://github.com/TfTHacker/obsidian42-brat
[gh]: https://cli.github.com/
