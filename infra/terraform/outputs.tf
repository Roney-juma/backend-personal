output "alb_dns_name" {
  description = "Point your Route 53 record (CNAME/alias) at this."
  value       = aws_lb.this.dns_name
}

output "redis_primary_endpoint" {
  description = "ElastiCache primary endpoint (already wired into tasks as REDIS_URL)."
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "ecs_cluster" {
  value = aws_ecs_cluster.this.name
}
