#!/bin/bash

# Finder launches .command files in Terminal, potentially from another folder.
keep_terminal_open() {
  local status=$?
  echo
  if [ "$status" -ne 0 ] && [ "$status" -ne 130 ]; then
    echo "Siftly exited with an error (code $status). See the output above."
  else
    echo "Siftly has stopped."
  fi
  read -r -p "Press Return to close this launcher..." _
}

trap keep_terminal_open EXIT
# Let Ctrl+C stop the server, then leave its output visible.
trap ':' INT

cd -- "$(dirname -- "$0")" || exit 1
bash ./start.sh
exit $?
