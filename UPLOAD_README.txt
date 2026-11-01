HUMKT Auto Buyer V3.1.2 - Direct replacement files

This archive contains complete replacement files with their original repository paths.

Upload/overwrite these five paths in the GitHub repository:
- src/main.ts
- src/worker.ts
- src/renderer/index.html
- package.json
- .github/workflows/build-windows.yml

Do not upload the archive itself. Extract it first, then upload the five files while preserving their paths.

The code keeps the current app architecture and API routes. The configured quantity is a ceiling up to 200; actual quantity is reduced to available stock and positive platform max_qty values. If the result is below min_qty, no order is submitted.

Shutdown behavior: the app asks the worker to stop, wakes its wait timers, aborts read-only polling, but does not abort an order POST already sent. It waits for the worker before saving and closing SQLite. If an order request times out, the unknown-order lock is retained to prevent duplicate submissions.

This is a source replacement package, not a prebuilt EXE. GitHub Actions must build the EXE after the files are uploaded.
