#!/usr/bin/env bash
# Pre-publish scan: private names, mailboxes, hosts and secret-looking strings
# must not be in the repo. Exit 1 on any hit. Run: scripts/check-secrets.sh
set -uo pipefail
cd "$(dirname "$0")/.."
FORBIDDEN='sheraton|juzer|shehryar|harps@|sheria|kimti|kush\b|lamtek|marble group|bsh\b|hickman|quooker|blanco|hafele|youlend|funding circle|89\.167\.124|\bthor\b|jarvis|sheratonos|sheratoninteriors|261796965'
SECRETS='sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|fa_[A-Za-z0-9_-]{30,}|AIza[0-9A-Za-z_-]{30,}|"client_secret"\s*:\s*"[^"]{8,}"|ABSQ[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}'
status=0
hits=$(git ls-files --cached --others --exclude-standard | grep -v -E '^(package-lock\.json)$' | xargs grep -n -i -E "$FORBIDDEN" 2>/dev/null | grep -v 'scripts/check-secrets.sh' || true)
if [ -n "$hits" ]; then echo "FORBIDDEN NAMES:"; echo "$hits"; status=1; fi
shits=$(git ls-files --cached --others --exclude-standard | grep -v -E '^(package-lock\.json)$' | xargs grep -n -E "$SECRETS" 2>/dev/null | grep -v 'scripts/check-secrets.sh' || true)
if [ -n "$shits" ]; then echo "SECRET-LIKE STRINGS:"; echo "$shits"; status=1; fi
envs=$(git ls-files --cached --others --exclude-standard | grep -E '^\.env(\..+)?$' | grep -v '^\.env\.example$' || true)
if [ -n "$envs" ]; then echo "ENV FILES TRACKED:"; echo "$envs"; status=1; fi
data=$(git ls-files --cached --others --exclude-standard | grep -E '^data/' || true)
if [ -n "$data" ]; then echo "DATA FILES TRACKED:"; echo "$data"; status=1; fi
[ $status -eq 0 ] && echo "clean: no private names, secrets, env or data files tracked"
exit $status
