# Multi-AZ Redis with automatic failover — replaces the single localhost Redis.
# Powers BullMQ (jobs), the Socket.IO adapter, and shared rate-limit counters.

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${local.name}-redis"
  subnet_ids = var.private_subnet_ids
  tags       = local.tags
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${local.name}-redis"
  description          = "AVE Redis (queue + socket adapter + rate limit)"

  engine         = "redis"
  node_type      = var.redis_node_type
  num_cache_clusters = 2 # 1 primary + 1 replica in a second AZ

  # HA: promote the replica automatically if the primary's AZ fails.
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [aws_security_group.redis.id]

  port                       = 6379
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true # NOTE: app must use rediss:// when this is on

  # Persist so a full failure doesn't drop enqueued jobs.
  snapshot_retention_limit = 5

  tags = local.tags
}
