# Terminal demo (reserved slot)

`quickstart.tape` is the [VHS](https://github.com/charmbracelet/vhs) script of the terminal GIF of the README: it types the
"secrets" and "start" steps of the quickstart of the docs (the `.env` first, then `docker compose up --build`) on the demo
instance, up to the first sign-in. Run it from the root of the repository: `vhs .github/assets/demo/quickstart.tape` (it writes
to `.github/assets/demo/` and types the commands in `runtime/`). The GIF itself
(`quickstart-en.gif`, `quickstart-fr.gif`, at most 1.5 MB each) is produced by task 3.11, which ships the demo mode; until
then the slot is reserved and `assert_demo_recording_reproducible` is a `test.todo`.

Rules of a recording (`scripts/vitrine/budgets.json`): fixtures only, no real site, no key, no personal path, a visible
"Recorded demo" banner, no request outside the demo instance (a request outside it fails the recording).
