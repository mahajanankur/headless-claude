#!/bin/sh
# GIT_ASKPASS helper: git asks for "Username for ..." then "Password for ...".
case "$1" in
  Username*) printf '%s\n' "$GW_GIT_USERNAME" ;;
  *) printf '%s\n' "$GW_GIT_PASSWORD" ;;
esac
