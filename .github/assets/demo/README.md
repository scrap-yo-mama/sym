# Terminal demo (reserved slot)

`quickstart.tape` is the [VHS](https://github.com/charmbracelet/vhs) script of the terminal GIF of the README: it replays the
quickstart of the docs on the demo instance, from `docker compose up` to the first sign-in. The GIF itself
(`quickstart-en.gif`, `quickstart-fr.gif`, at most 1.5 MB each) is produced by task 3.11, which ships the demo mode; until
then the slot is reserved and `assert_demo_recording_reproducible` is a `test.todo`.

Rules of a recording (`scripts/vitrine/budgets.json`): fixtures only, no real site, no key, no personal path, a visible
"Recorded demo" banner, no request outside the demo instance (a request outside it fails the recording).
