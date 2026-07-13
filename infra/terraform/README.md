# AVE HA infrastructure (Terraform scaffold)

Provisions a highly-available deployment of the backend on AWS:

- **ALB** across ≥2 AZs (HTTPS, `/ready` health checks, sticky sessions for Socket.IO)
- **ECS Fargate** — `app` service (≥2 tasks, auto-scaling) + `worker` service (≥2 tasks)
- **ElastiCache Redis** (Multi-AZ, automatic failover, encrypted) — replaces localhost Redis
- Security groups, IAM roles, CloudWatch logs, CPU auto-scaling, rolling zero-downtime deploys

> This is a **scaffold**. It assumes an existing VPC with public + private subnets and a
> NAT per AZ. Review every resource before `apply`. MongoDB stays on Atlas (upgrade to
> M10+ for replica-set failover) and is referenced only via the `MONGO_URI` secret.

## Prerequisites

1. **VPC** with ≥2 public and ≥2 private subnets across different AZs, NAT per AZ.
2. **ACM certificate** for your domain, in the same region.
3. **ECR image** built from the repo `Dockerfile` and pushed.
4. **Secrets Manager** secret (JSON) holding app secrets — keys like `MONGO_URI`,
   `TOKEN_SECRET`, `ENCRYPTION_SECRET`, `JWT_KEY`, AWS keys, WhatsApp/email creds.
   Add each key to `common_secrets` in `ecs.tf`.

## Build & push the image

```bash
aws ecr create-repository --repository-name ave-backend
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com
docker build -t ave-backend .
docker tag ave-backend:latest <acct>.dkr.ecr.us-east-1.amazonaws.com/ave-backend:latest
docker push <acct>.dkr.ecr.us-east-1.amazonaws.com/ave-backend:latest
```

## Apply

```bash
cd infra/terraform
terraform init
terraform apply \
  -var vpc_id=vpc-xxxx \
  -var 'public_subnet_ids=["subnet-a","subnet-b"]' \
  -var 'private_subnet_ids=["subnet-c","subnet-d"]' \
  -var acm_certificate_arn=arn:aws:acm:us-east-1:...:certificate/... \
  -var image=<acct>.dkr.ecr.us-east-1.amazonaws.com/ave-backend:latest \
  -var app_secret_arn=arn:aws:secretsmanager:us-east-1:...:secret:ave-app-xxxx
```

Then point Route 53 at the `alb_dns_name` output.

## Notes / follow-ups

- **Transit encryption is ON** for Redis, so tasks connect with `rediss://` (already
  set in `ecs.tf`). ioredis handles TLS from the `rediss://` scheme automatically.
- **App code prerequisites (already committed):** Socket.IO Redis adapter, Redis-backed
  rate limiting, and Mongo `retryWrites` — these are what make running ≥2 tasks safe.
- **Deploys:** push a new image tag and `aws ecs update-service --force-new-deployment`
  (or wire CodeDeploy blue/green). Rolling config keeps ≥100% healthy throughout.
- **Alarms (add next):** ALB `UnHealthyHostCount`, `HTTPCode_Target_5XX_Count`, ECS CPU,
  ElastiCache failover events → SNS.
- **Frontend:** host `provider-fe` on Amplify/CloudFront separately.
