#!/bin/sh
case "$1" in
  echo) shift; echo "out:$*"; echo "err:$*" >&2 ;;
  fail) echo "boom" >&2; exit 3 ;;
  path) echo "$PATH" ;;
  hang) sleep 300 & echo "child:$!"; wait ;;
esac
