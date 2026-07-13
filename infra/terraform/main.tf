locals {
  name = var.project

  tags = {
    Project   = var.project
    ManagedBy = "terraform"
  }
}

# ── Security groups ───────────────────────────────────────────────────────────

# ALB: public HTTPS/HTTP in.
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB ingress from internet"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTP (redirected to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# App tasks: only reachable from the ALB, on the container port.
resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "ECS app tasks"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    description     = "from ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Redis: only reachable from app + worker tasks.
resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "ElastiCache Redis"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    description     = "Redis from app/worker"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
