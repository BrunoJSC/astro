-- Keyspace.
--
-- Development: SimpleStrategy with RF 1. It ignores racks and datacentres,
-- which is exactly what a single local node wants, and exactly what production
-- must not have -- RF 1 means one node's disk is the only copy.
--
-- Run this file first; every other file assumes the keyspace exists.

CREATE KEYSPACE IF NOT EXISTS astro_chat
  WITH replication = {
    'class': 'SimpleStrategy',
    'replication_factor': 1
  };

-- Production. Replace the block above with this one, naming your real
-- datacentres. RF 3 per DC is the standard: it survives one node down while
-- still allowing QUORUM (2 of 3) reads and writes.
--
-- CREATE KEYSPACE IF NOT EXISTS astro_chat
--   WITH replication = {
--     'class': 'NetworkTopologyStrategy',
--     'us-east': 3,
--     'eu-west': 3
--   }
--   AND durable_writes = true;
