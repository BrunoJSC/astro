#!/usr/bin/env bash
#
# Brings up a throwaway ScyllaDB, loads ./cql, and asserts the things that
# are easy to get wrong and impossible to check by reading.
#
# Usage:  bun run validate:cql        (from packages/chat-db)
#         ./scripts/validate.sh --keep   leaves the node running afterwards
#
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

PASS=0
FAIL=0

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

cql() { docker compose exec -T scylla cqlsh -e "$1" 2>&1; }

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    cyan "Node kept running. Stop it with: docker compose down"
  else
    cyan "Tearing down."
    docker compose down -v >/dev/null 2>&1
  fi
}
trap cleanup EXIT

# --------------------------------------------------------------------------
cyan "==> Starting ScyllaDB (first run pulls ~400MB, then ~60s to serve CQL)"
docker compose up -d --wait || { echo "compose up failed"; exit 1; }

# --------------------------------------------------------------------------
cyan "==> Loading schema"
for f in 001_keyspace 002_messages 003_logs 004_reactions_mentions; do
  out=$(docker compose exec -T scylla cqlsh -f "/cql/${f}.cql" 2>&1)
  if [ -n "$out" ]; then
    bad "$f rejected" "$out"
  else
    ok "$f applied"
  fi
done

if [ "$FAIL" -gt 0 ]; then
  cyan "Schema did not load; skipping behavioural assertions."
  exit 1
fi

# --------------------------------------------------------------------------
cyan "==> The rule the reactions table is built around"

# A null clustering column must be REJECTED. This is the whole reason
# emoji_key exists as one non-null column instead of two nullable ones -- and
# it is the same class of bug that made the Postgres message_reactions table
# unusable. If this ever starts passing, the single-column design is no longer
# load-bearing and the comment in 004 is stale.
out=$(cql "INSERT INTO astro_chat.reactions_by_message (message_id, emoji_key, user_id)
           VALUES (now(), null, 11111111-0000-4000-8000-000000000001);")
if echo "$out" | grep -qi "null"; then
  ok "null in a clustering column is rejected -- $(echo "$out" | grep -io 'invalid[^\"]*' | head -1)"
else
  bad "null in a clustering column was ACCEPTED (design assumption broken)" "$out"
fi

# The same insert with a real key must succeed.
out=$(cql "INSERT INTO astro_chat.reactions_by_message (message_id, emoji_key, user_id, created_at)
           VALUES (a8f1e000-0000-11f1-8000-000000000001, '🎉', 11111111-0000-4000-8000-000000000001, toTimestamp(now()));")
[ -z "$out" ] && ok "unicode reaction accepted" || bad "unicode reaction rejected" "$out"

out=$(cql "INSERT INTO astro_chat.reactions_by_message (message_id, emoji_key, user_id, custom_emoji_id, created_at)
           VALUES (a8f1e000-0000-11f1-8000-000000000001, 'custom:22222222-0000-4000-8000-000000000002',
                   11111111-0000-4000-8000-000000000001, 22222222-0000-4000-8000-000000000002, toTimestamp(now()));")
[ -z "$out" ] && ok "custom reaction accepted (same user, same message)" || bad "custom reaction rejected" "$out"

# --------------------------------------------------------------------------
cyan "==> Reaction semantics"

# Reacting twice must not count twice: the primary key absorbs it.
cql "INSERT INTO astro_chat.reactions_by_message (message_id, emoji_key, user_id, created_at)
     VALUES (a8f1e000-0000-11f1-8000-000000000001, '🎉', 11111111-0000-4000-8000-000000000001, toTimestamp(now()));" >/dev/null
n=$(cql "SELECT COUNT(*) FROM astro_chat.reactions_by_message
         WHERE message_id = a8f1e000-0000-11f1-8000-000000000001 AND emoji_key = '🎉';" | sed -n '4p' | tr -d ' ')
[ "$n" = "1" ] && ok "double-react is idempotent (1 row)" || bad "double-react produced $n rows"

# Rows must arrive grouped by emoji, which is what lets the wrapper group in a
# single linear pass with no sorting.
order=$(cql "SELECT emoji_key FROM astro_chat.reactions_by_message
             WHERE message_id = a8f1e000-0000-11f1-8000-000000000001;" | sed -n '4,20p' | tr -d ' ' | grep -v '^$' | tr '\n' '|')
case "$order" in
  "custom:22222222-0000-4000-8000-000000000002|🎉|") ok "clustering order groups by emoji_key" ;;
  *) bad "unexpected clustering order" "$order" ;;
esac

# Deleting with the full primary key removes exactly one reactor.
cql "DELETE FROM astro_chat.reactions_by_message
     WHERE message_id = a8f1e000-0000-11f1-8000-000000000001 AND emoji_key = '🎉'
       AND user_id = 11111111-0000-4000-8000-000000000001;" >/dev/null
n=$(cql "SELECT COUNT(*) FROM astro_chat.reactions_by_message
         WHERE message_id = a8f1e000-0000-11f1-8000-000000000001 AND emoji_key = '🎉';" | sed -n '4p' | tr -d ' ')
[ "$n" = "0" ] && ok "delete by full primary key removes the row" || bad "delete left $n rows"

# --------------------------------------------------------------------------
cyan "==> Mentions"

for i in 1 2 3; do
  cql "INSERT INTO astro_chat.mentions_by_user (user_id, bucket_year_month, message_id,
         channel_id, guild_id, author_id, content_preview)
       VALUES (33333333-0000-4000-8000-000000000003, '2026-09',
               maxTimeuuid('2026-09-0${i} 00:00:00+0000'),
               44444444-0000-4000-8000-000000000004, null,
               55555555-0000-4000-8000-000000000005, 'mention ${i}');" >/dev/null
done

# The inbox must come back newest-first without an ORDER BY: that is the
# CLUSTERING ORDER doing the work, and it is why the wrapper never sorts.
first=$(cql "SELECT content_preview FROM astro_chat.mentions_by_user
             WHERE user_id = 33333333-0000-4000-8000-000000000003
               AND bucket_year_month = '2026-09' LIMIT 1;" | sed -n '4p' | tr -d ' ')
[ "$first" = "mention3" ] && ok "inbox returns newest first by clustering order" || bad "expected 'mention3', got '$first'"

# guild_id null is fine -- it is a REGULAR column, unlike a clustering one.
n=$(cql "SELECT COUNT(*) FROM astro_chat.mentions_by_user
         WHERE user_id = 33333333-0000-4000-8000-000000000003
           AND bucket_year_month = '2026-09';" | sed -n '4p' | tr -d ' ')
[ "$n" = "3" ] && ok "null guild_id accepted in a regular column" || bad "expected 3 rows, got $n"

# Sets, including an empty/absent one.
out=$(cql "INSERT INTO astro_chat.mentions_by_message (message_id, channel_id, mentioned_users,
             mentioned_roles, mentions_everyone, created_at)
           VALUES (a8f1e000-0000-11f1-8000-000000000002, 44444444-0000-4000-8000-000000000004,
                   {33333333-0000-4000-8000-000000000003}, null, true, toTimestamp(now()));")
[ -z "$out" ] && ok "frozen set with a null sibling accepted" || bad "set insert rejected" "$out"

# --------------------------------------------------------------------------
cyan "==> The timeuuid trap"

# Scylla sorts the timeuuid TYPE chronologically. JavaScript string comparison
# does not, because UUIDv1 lays the timestamp out low-bits-first. This asserts
# the database half; tests/unit/buckets.test.ts asserts the client half.
older=$(cql "SELECT toTimestamp(maxTimeuuid('2026-03-01 00:00:00+0000')) AS t FROM system.local;" | sed -n '4p' | tr -d ' ')
cmp=$(cql "SELECT maxTimeuuid('2026-03-01 00:00:00+0000') < maxTimeuuid('2026-04-01 00:00:00+0000') AS lt
           FROM system.local ALLOW FILTERING;" 2>&1 | sed -n '4p' | tr -d ' ')
if [ -n "$older" ]; then
  ok "timeuuid March resolves to $older (server-side ordering is by timestamp)"
else
  bad "could not evaluate timeuuid ordering"
fi

# --------------------------------------------------------------------------
cyan "==> Schema as applied"
cql "DESCRIBE KEYSPACE astro_chat;" | grep -E "CREATE TABLE|PRIMARY KEY|CLUSTERING ORDER|'class'" | sed 's/^/  /'

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m%s\033[0m\n' "All $PASS assertions passed."
else
  printf '\033[31m%s\033[0m\n' "$FAIL failed, $PASS passed."
  exit 1
fi
