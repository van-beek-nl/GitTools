# GitTools worker
JavaScript worker that performs the git operations of the GitTools library.

## Getting started
There's no need to install the worker yourself. Whenever GitTools starts the worker, it copies the `gittools_worker` directory next to `GitTools.lbs` into the `jsworker` directory of Omnis Studio.

## Development
The worker must satisfy the following constraints:
- **CommonJS**  
    Omnis Studio loads the worker as a CommonJS module, so use `require` and `module.exports` rather than ES modules.
- **Node.js v16.6.1**  
    Omnis Studio 10.22 bundles Node.js v16.6.1, so the worker must not use any language features or APIs introduced after that version.
- **No dependencies**  
    The worker only uses the built-in modules of Node.js, so there is nothing to install.

`index.js` is the only file that depends on Omnis Studio. It passes every call on to `run()` in `src/core.js`, which performs the requested operation and returns its result. This allows the worker to be tested without Omnis Studio.

## Testing
The unit tests use the built-in test runner of Node.js, and run the worker against temporary git repositories. Running them requires Node.js v16.17.0 or higher and [Git >= v2.45](https://git-scm.com/) present in your path environment variable. To run all tests:
```
npm test
```
To run a single test file:
```
node --test test/<name>.test.js
```
Shared test helpers are placed in `test-support/` rather than `test/`, as the test runner would otherwise treat them as a test file.

The tests run automatically on GitLab and GitHub whenever the worker changes, using both the oldest supported and the latest versions of Node.js and git.
