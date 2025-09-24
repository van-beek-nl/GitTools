# GitTools
Omnis library to improve working with JSON source and git.

## Prerequisites
- [Git](https://git-scm.com/) installed and present in your path environment variable.
- [Omnis Studio](https://www.omnis.net/) v10.22 or higher.

## Getting started
Installing GitTools is simple: copy `GitTools.lbs.release` to your Omnis Studio startup directory and rename it to `GitTools.lbs`. You should also manually open the library once to ensure it gets converted to your version of Omnis Studio. When you start Omnis, a new GitTools menu item should appear. GitTools will attempt to register all currently opened libraries, populating the menu. In Omnis Studio 11+, GitTools will also automatically find and register newly opened libraries. For older versions, you can manually register your library in a safe manner by putting the following code in your library's startup task:
```
If $itasks.["GitTools"].["$openlibschanged"].$cando()
    Do $itasks.["GitTools"].["$openlibschanged"]()
End if
```

To register a library, it must satisfy the following requirements:
- A GitTools config file should be present for the library. This file must be placed next to the library file, and its name should be `<library file name excluding .lbs>.gittools.json`. For example, if your library file name is `MyCoolLibrary.lbs`, a config file called `MyCoolLibrary.gittools.json` should be present next to it. See [GitTools config file format](#gittools-config-file-format) for more information.
- The source directory of the library must be part of a git repository.

Finally, GitTools generates meta files for libraries to keep track of certain information. This information is *local only*. GitTools may also leave certain other artifacts behind, such as import backups and other artifacts when its interrupted. You should add the following lines to your repository's gitignore:
```
*.gittools.meta
*.lbs.import
*.lbs.bak
```

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