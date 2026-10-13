#!/bin/sh
case "$1" in
  echo) shift; echo "out:$*"; echo "err:$*" >&2 ;;
  # The number of arguments, then each argument as it arrived, every one followed by a NUL.
  args) shift; printf '%s\0' "$#" "$@" ;;
  # A server launch: the path this was run by, then the same report, `mcp` being the first argument.
  mcp) printf '%s\0' "$0" "$#" "$@" ;;
  fail) echo "boom" >&2; exit 3 ;;
  path) echo "$PATH" ;;
  # The working directory this was started in.
  pwd) pwd ;;
  hang) sleep 300 & echo "child:$!"; wait ;;
  stubborn) (trap '' TERM; sleep 300) & echo "child:$!"; exit 0 ;;
esac
