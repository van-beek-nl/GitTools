# GitTools
Omnis library to improve working with JSON source and git.

## Prerequisites
- [Git >= v2.45](https://git-scm.com/) installed and present in your path environment variable.
- [Omnis Studio](https://www.omnis.net/) v10.22 or higher.

## Getting started
Installing GitTools is simple:
- Download the latest release from the GitHub releases page.
- Copy `GitTools.lbs` and `gittools_worker` to your Omnis Studio startup directory.
- You may have to manually open the library once to ensure it gets converted to your version of Omnis Studio. When you start Omnis, a new GitTools menu item should appear.

### Automatic library registration
GitTools will attempt to register all currently opened libraries upon startup, populating the menu. In Omnis Studio 11+, GitTools will also automatically find and register newly opened libraries. For older versions, you can either manually trigger this feature with the `GitTools -> Update library register` menu option, or you can programmatically trigger the feature in safe manner by putting the following code in your library's startup task:
```
If $itasks.["GitTools"].["$openlibschanged"].$cando()
    Do $itasks.["GitTools"].["$openlibschanged"]()
End if
```

To automatically register a library, it must satisfy the following requirements:
- A GitTools config file should be present for the library. This file must be placed next to the library file, and its name should be `<library file name excluding .lbs>.gittools.json`. For example, if your library file name is `MyCoolLibrary.lbs`, a config file called `MyCoolLibrary.gittools.json` should be present next to it. See [GitTools config file format](#gittools-config-file-format) for more information.
- The source directory of the library must be part of a git repository.

### Manual library registration
The `GitTools -> Register library` menu option lists all currently opened libraries that have not been registered yet, allowing you to register them with a single click. Libraries placed in the Omnis Studio startup directory are not listed. The `GitTools -> Register library -> Register from file...` menu option lets you register a library using either the path to the library or the path to its config file. If there are no unregistered libraries open, the `GitTools -> Register library` menu option will immediately ask you for a file instead. Registering a library will also create an empty GitTools config file if the selected library does not have one yet.

### Programmatic library registration
The GitTools startup task also allows you to register and deregister libraries from your own code. The following methods are available, all of which return `kTrue` when successful:
- **`$registerLibrary(pLibrary)`**  
    Registers the library with the given library reference, for example `$clib`. The library must already have a GitTools config file.
- **`$registerLibraryFromPath(pPath)`**  
    Registers a library using either the path to the library or the path to its config file. This will also create an empty GitTools config file if the library does not have one yet.
- **`$deregisterLibrary(pLibrary)`**  
    Deregisters the library with the given library reference.

As with `$openlibschanged`, check whether GitTools is available before calling any of these methods:
```
If $itasks.["GitTools"].["$registerLibrary"].$cando()
    Do $itasks.["GitTools"].["$registerLibrary"]($clib)
End if
```

## Library actions
If you've registered a single library, its import and export actions are shown directly in the GitTools menu, and its other actions can be found under `GitTools -> More actions`. If you've registered multiple libraries, each library gets its own submenu instead, and the `GitTools -> Import all` and `GitTools -> Export all` menu options let you import or export all registered libraries at once. The following actions are available for each library:
- **Import**  
    Imports the library from its source directory.
- **Export**  
    Exports the library to its source directory.
- **Reload config**  
    Reloads the library's GitTools config file. Use this after making changes to the config file.
- **Open config file**  
    Opens the library's GitTools config file.
- **Open directory**  
    Opens the directory containing the library.
- **Clear export cache**  
    GitTools keeps a cache of previous exports to speed up future exports. In rare cases, this cache can become outdated or corrupted, causing your changes to be missing from exports. Clearing the cache forces the next export to write out the entire library. This is safe to do at any time, but the next export will take longer.

## Automated git config changes
By default, GitTools will automatically modify the following files in your git repository (relative to the repository root):
- `.gitignore`  
    GitTools creates and uses several files such as temporary import artifacts and library backups. These files should not be committed to the git repository. The same goes for the library files (`.lbs`) themselves, as the JSON source is what gets committed instead. GitTools amends the `.gitignore` file to prevent these files from being picked up by git. The changes to this file should be committed to your repository.
- `.gitattributes`  
    Git has no inherent understanding of the file formats Omnis uses. GitTools amends your repository's `.gitattributes` file to help git understand what to do with certain files. For example, this enables proper diffing of string table (.tsv) files, as these files use old-school Macintosh line endings (CR, no LF). It also keeps method (.omh) files byte for byte as Omnis writes them (CRLF), regardless of your `core.autocrlf` setting. The changes to this file should be committed to your repository.
- `.git/config`  
    GitTools will amend your local repository config to add the custom diff-er for CR-based line endings mentioned above. In the future, GitTools may also add support for more advanced merge logic by using a custom merge driver.

You can change this behavior in the GitTools settings (Settings -> Auto update repository config). GitTools never modifies these files if the library's git repository is a submodule of another repository.

## Settings
The `GitTools -> Settings` menu contains the following options:
- **Auto update repository config**  
    Enables or disables the [automated git config changes](#automated-git-config-changes). Enabled by default.
- **Discard irrelevant changes**  
    Omnis updates some class metadata (`moddate` and `internalversion`) when exporting, even if nothing else about the class has changed. These changes don't matter when importing, but they do cause unnecessary merge conflicts. When enabled, GitTools discards changes to these values after exporting. Enabled by default.
- **Change git executable**  
    Changes the git executable used by GitTools. By default, GitTools uses the `git` executable found in your path environment variable.
- **Log level**  
    Changes how much information GitTools writes to the trace log: `Errors`, `Warnings`, `Info` or `Debug`. Defaults to `Info`.
- **Open config file**  
    Opens the GitTools settings file.
- **Open directory**  
    Opens the directory containing GitTools.

## GitTools config file format
GitTools doesn't require much in the way of configuration. Currently, *all* configuration parameters are optional. To use the GitTools defaults, simply put `{}` in your GitTools config file. You can tweak the following options:
- **jsonPath**  
    The path to your library's source directory, relative to the library file. This is where JSON exports are written to and read from. Defaults to `./src`.
- **preImportScript**  
    An array of GitTools script actions to run before importing a library from JSON. See [Scripting](#scripting) for more information.
- **postImportScript**  
    An array of GitTools script actions to run after importing a library from JSON. See [Scripting](#scripting) for more information.
- **preExportScript**  
    An array of GitTools script actions to run before exporting a library to JSON. See [Scripting](#scripting) for more information.
- **postExportScript**  
    An array of GitTools script actions to run after exporting a library to JSON. See [Scripting](#scripting) for more information.

## Scripting
GitTools supports running scripts before and after performing imports and exports. This allows you to perform various actions should your library require them. For example, you could copy additional files over to an external directory after an import to make sure that externally placed dependencies are also up-to-date. The following script actions are available:
- **`eval <Omnis calculation>`**  
    Evaluates the given Omnis calculation using the built-in [`eval()`](https://www.omnis.net/developers/resources/onlinedocs/index.jsp?detail=FunctionRef/Functions_A-Z/eval.html) function.
- **`copy <source path> <destination path>`**  
    Copies the given source path to the given destination path. Paths can be relative to the config file's parent directory or absolute. Paths containing spaces must be wrapped in double quotes.
- **`move <source path> <destination path>`**  
    Moves the given source path to the given destination path. Paths can be relative to the config file's parent directory or absolute. Paths containing spaces must be wrapped in double quotes.
- **`delete <path>`**  
    Deletes the given path recursively. Paths can be relative to the config file's parent directory or absolute.
- **`shell [platform] <command>`**  
    Runs the given shell command using the operating system's shell environment. For Windows, this uses the batch scripting syntax. For macOS, this uses `/bin/sh`, without loading your shell profile. Linux is currently unsupported. To use platform-specific commands, prepend your command with `windows` or `macos`. For example: `shell windows start calc.exe` or `shell macos open /System/Applications/Calculator.app`.