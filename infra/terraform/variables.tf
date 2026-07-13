variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "ave"
}

# ── Networking (use your existing VPC) ────────────────────────────────────────
variable "vpc_id" {
  type        = string
  description = "Existing VPC id to deploy into."
}

variable "public_subnet_ids" {
  type        = list(string)
  description = "≥2 public subnets in different AZs (for the ALB)."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "≥2 private subnets in different AZs (for ECS tasks + ElastiCache). Need a NAT per AZ for egress."
}

# ── TLS + DNS ─────────────────────────────────────────────────────────────────
variable "acm_certificate_arn" {
  type        = string
  description = "ACM cert ARN for the HTTPS listener (must be in var.aws_region)."
}

# ── Container image ───────────────────────────────────────────────────────────
variable "image" {
  type        = string
  description = "Full image URI, e.g. <acct>.dkr.ecr.us-east-1.amazonaws.com/ave-backend:latest"
}

variable "container_port" {
  type    = number
  default = 3000
}

# ── Sizing / HA ───────────────────────────────────────────────────────────────
variable "app_desired_count" {
  type    = number
  default = 2 # ≥2 across AZs = survives one task/AZ failing
}

variable "app_min_count" {
  type    = number
  default = 2
}

variable "app_max_count" {
  type    = number
  default = 6
}

variable "worker_desired_count" {
  type    = number
  default = 2
}

variable "task_cpu" {
  type    = number
  default = 512
}

variable "task_memory" {
  type    = number
  default = 1024
}

# ── Redis (ElastiCache) ───────────────────────────────────────────────────────
variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

# ── Secrets ───────────────────────────────────────────────────────────────────
variable "app_secret_arn" {
  type        = string
  description = "AWS Secrets Manager secret ARN holding app secrets (MONGO_URI, TOKEN_SECRET, AWS keys, WhatsApp, etc.) as JSON keys."
}
