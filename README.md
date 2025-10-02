# GitTools
Omnis library to improve working with JSON source and git.

## Prerequisites
- [Git >= v2.23](https://git-scm.com/) installed and present in your path environment variable.
- [Omnis Studio](https://www.omnis.net/) v10.22 or higher.

## Getting started
Installing GitTools is simple: copy `GitTools.lbs.release` to your Omnis Studio startup directory and rename it to `GitTools.lbs`. You should also manually open the library once to ensure it gets converted to your version of Omnis Studio. When you start Omnis, a new GitTools menu item should appear.

### Automatic library registration
GitTools will attempt to register all currently opened libraries upon startup, populating the menu. In Omnis Studio 11+, GitTools will also automatically find and register newly opened libraries. For older versions, you can either manually trigger this feature with the `GitTools -> Scan for libraries` menu option, or you can programmatically trigger the feature in safe manner by putting the following code in your library's startup task:
```
If $itasks.["GitTools"].["$openlibschanged"].$cando()
    Do $itasks.["GitTools"].["$openlibschanged"]()
End if
```

To automatically register a library, it must satisfy the following requirements:
- A GitTools config file should be present for the library. This file must be placed next to the library file, and its name should be `<library file name excluding .lbs>.gittools.json`. For example, if your library file name is `MyCoolLibrary.lbs`, a config file called `MyCoolLibrary.gittools.json` should be present next to it. See [GitTools config file format](#gittools-config-file-format) for more information.
- The source directory of the library must be part of a git repository.

### Manual library registration
The `GitTools -> Register library` menu option lets you register a library using either the path to the library or the path to its config file. This will also create an empty GitTools config file if the selected library does not have one yet.

## Automated git config changes
By default, GitTools will automatically modify the following files in your git repository (relative to the repository root):
- `.gitignore`
    GitTools creates and uses several files such as meta files that track local repository changes, temporary import artifacts, and library backups. These files should not be committed to the git repository. GitTools amends the `.gitignore` file to prevent these files from being picked up by git. The changes to this file should be committed to your repository.
- `.gitattributes`
    Git has no inherent understanding of the file formats Omnis uses. GitTools amends your repository's `.gitattributes` file to help git understand what to do with certain files. For example, this enables proper diffing of string table (.tsv) files, as these files use old-school Macintosh line endings (CR, no LF). The changes to this file should be committed to your repository.
- `.git/config`
    GitTools will amend your local repository config to add the custom diff-er for CR-based line endings mentioned above. In the future, GitTools may also add support for more advanced merge logic by using a custom merge driver.

You can change this behavior in the GitTools settings (Settings -> Auto update repository config).

## GitTools config file format
GitTools doesn't require much in the way of configuration. Currently, *all* configuration parameters are optional. To use the GitTools defaults, simply put `{}` in your GitTools config file. You can tweak the following options:
- **jsonPath**  
    The (relative) path to your library's source directory. This is where JSON exports are written to and read from.
- **preImportScript**  
    An array of GitTools script actions to run before importing a library from JSON. See [Scripting](#scripting) for more information.
- **postImportScript**  
    An array of GitTools script actions to run after importing a library from JSON. See [Scripting](#scripting) for more information.
- **preExportScript**  
    An array of GitTools script actions to run before exporting a library from JSON. See [Scripting](#scripting) for more information.
- **postExportScript**  
    An array of GitTools script actions to run after exporting a library from JSON. See [Scripting](#scripting) for more information.

## Scripting
GitTools supports running scripts before and after performing imports and exports. This allows you to perform various actions should your library require them. For example, you could copy additional files over to an external directory after an import to make sure that externally placed dependencies are also up-to-date. The following script actions are available:
- **`eval <Omnis calculation>`**  
    Evaluates the given Omnis calculation using the built-in [`eval()`](https://www.omnis.net/developers/resources/onlinedocs/index.jsp?detail=FunctionRef/Functions_A-Z/eval.html) function.
- **`copy <source path> <destination path>`**  
    Copies the given source path to the given destination path. Paths can be relative to the config file's parent directory or absolute.
- **`move <source path> <destination path>`**  
    Moves the given source path to the given destination path. Paths can be relative to the config file's parent directory or absolute.
- **`delete <path>`**  
    Deletes the given path recursively. Paths can be relative to the config file's parent directory or absolute.
- **`shell [platform] <command>`**  
    Runs the given shell command using the operating system's shell environment. For Windows, this uses the batch scripting syntax. For macOS, this uses the default shell (so probably zsh). Linux is currently unsupported. To use platform-specific commands, prepend your command with `windows` or `macos`. For example: `shell windows start calc.exe` or `shell macos open /System/Applications/Calculator.app`.