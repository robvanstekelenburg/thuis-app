#!/usr/bin/env bash
# Haalt een API-sleutel van het Supabase-project op via de Management API.
#   scripts/sb-key.sh publishable   → publieke sleutel (of legacy anon)
#   scripts/sb-key.sh secret        → geheime sleutel (of legacy service_role)
# Nodig: SUPABASE_ACCESS_TOKEN en SUPABASE_PROJECT_REF in de omgeving.
set -euo pipefail
want="$1"
legacy=$([ "$want" = secret ] && echo service_role || echo anon)
key=$(curl -fsS "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/api-keys?reveal=true" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" |
      jq -r --arg t "$want" --arg l "$legacy" \
        '(map(select(.type == $t and .api_key != null))[0].api_key) // (map(select(.name == $l))[0].api_key) // empty')
[ -n "$key" ] || { echo "Geen $want-sleutel gevonden" >&2; exit 1; }
echo "$key"
