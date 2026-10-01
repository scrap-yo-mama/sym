# VHS tape: terminal GIF of the README (task 4.12, filled in by task 3.11). Replayable: `vhs demo/quickstart.tape`.
# It only types the commands of the quickstart of the docs (the same ones `tests/quickstart.integration.test.ts` replays),
# on the demo instance built on fixtures. No real site, no key, no personal path. Task 3.11 adds the demo steps.
Output .github/assets/demo/quickstart-en.gif
Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 20
Set Width 1200
Set Height 675
Set Padding 24
Set Theme { "background": "#24252D", "foreground": "#FBF8F3", "cursor": "#FFC727" }
Set TypingSpeed 40ms
Set PlaybackSpeed 1
Set LoopOffset 0
Hide
Type "cd runtime"
Enter
Type "clear"
Enter
Show
Type "# Recorded demo: no real site, no key"
Enter
Sleep 600ms
Type "docker compose up --build"
Sleep 800ms
Enter
Sleep 4s
