# VHS tape: terminal GIF of the README (task 4.12, filled in by task 3.11). Run it from the root of the repository:
#   vhs .github/assets/demo/quickstart.tape
# It types, line by line, the "secrets" then "start" steps of the quickstart of the docs (the steps that
# `tests/quickstart.integration.test.ts` replays): the .env is created before `docker compose up`, so MASTER_KEY is set.
# Recorded on the demo instance built on fixtures. No real site, no key in the script, no personal path. Task 3.11 adds the
# demo steps that follow the start.
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
Type "# Recorded demo: no real site, no model key"
Enter
Sleep 600ms
Type "("
Enter
Type "  umask 077"
Enter
Type "  set -C"
Enter
Type "  {"
Enter
Type `    echo "MASTER_KEY=$(openssl rand -base64 32)"`
Enter
Type `    echo "ADMIN_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)"`
Enter
Type "  } > .env"
Enter
Type ")"
Enter
Sleep 600ms
Type "docker compose up --build"
Sleep 800ms
Enter
Sleep 4s
