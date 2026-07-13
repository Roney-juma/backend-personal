data "aws_region" "current" {}

resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}/app"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = 30
  tags              = local.tags
}

# ── IAM ───────────────────────────────────────────────────────────────────────

# Execution role: pull image + read secrets + write logs (used by the ECS agent).
resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

# Task role: what the APP itself can do at runtime (S3 for claim files, etc.).
resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

# TODO: scope this to the exact buckets the app uses (aveinsuranceclaims, backups).
resource "aws_iam_role_policy" "task_s3" {
  name = "s3-access"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
      Resource = ["arn:aws:s3:::aveinsuranceclaims", "arn:aws:s3:::aveinsuranceclaims/*"]
    }]
  })
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.app_secret_arn]
  }
}

# ── Shared container definition bits ──────────────────────────────────────────
locals {
  redis_url = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"

  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = tostring(var.container_port) },
    { name = "REDIS_URL", value = local.redis_url },
  ]

  # Pull individual keys out of the one JSON secret. Add every key the app reads
  # (MONGO_URI, TOKEN_SECRET, ENCRYPTION_SECRET, AWS keys, WhatsApp, email, ...).
  common_secrets = [
    { name = "MONGO_URI", valueFrom = "${var.app_secret_arn}:MONGO_URI::" },
    { name = "TOKEN_SECRET", valueFrom = "${var.app_secret_arn}:TOKEN_SECRET::" },
    { name = "ENCRYPTION_SECRET", valueFrom = "${var.app_secret_arn}:ENCRYPTION_SECRET::" },
    { name = "JWT_KEY", valueFrom = "${var.app_secret_arn}:JWT_KEY::" },
    # { name = "SECRET_KEY_AWS", valueFrom = "${var.app_secret_arn}:SECRET_KEY_AWS::" },
    # { name = "WHATSAPP_ACCESS_TOKEN", valueFrom = "${var.app_secret_arn}:WHATSAPP_ACCESS_TOKEN::" },
  ]
}

# ── API task + service ────────────────────────────────────────────────────────
resource "aws_ecs_task_definition" "app" {
  family                   = "${local.name}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name        = "app"
    image       = var.image
    command     = ["node", "src/app.js"]
    essential   = true
    portMappings = [{ containerPort = var.container_port }]
    environment = local.common_environment
    secrets     = local.common_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "app"
      }
    }
    healthCheck = {
      command     = ["CMD-SHELL", "curl -fsS http://localhost:${var.container_port}/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
  }])

  tags = local.tags
}

resource "aws_ecs_service" "app" {
  name            = "${local.name}-app"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.app_desired_count
  launch_type     = "FARGATE"

  # Zero-downtime rolling deploys: never drop below 100%, allow +100% surge.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = var.container_port
  }

  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}

# ── Worker task + service (no load balancer) ──────────────────────────────────
resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name        = "worker"
    image       = var.image
    command     = ["node", "src/worker.js"]
    essential   = true
    environment = local.common_environment
    secrets     = local.common_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.worker.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])

  tags = local.tags
}

resource "aws_ecs_service" "worker" {
  name            = "${local.name}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  tags = local.tags
}

# ── Auto scaling for the API (CPU target tracking) ────────────────────────────
resource "aws_appautoscaling_target" "app" {
  max_capacity       = var.app_max_count
  min_capacity       = var.app_min_count
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "app_cpu" {
  name               = "${local.name}-app-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.app.resource_id
  scalable_dimension = aws_appautoscaling_target.app.scalable_dimension
  service_namespace  = aws_appautoscaling_target.app.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
  }
}
