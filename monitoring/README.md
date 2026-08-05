# Backend monitoring — Prometheus + Grafana

Metrics for the AVE backend, running on the **same EC2 box** as the app. Everything
binds to `127.0.0.1` and is reached over an **SSH tunnel** — nothing is exposed to
the internet.

```
PM2 worker 0 ─ :9464/metrics ┐
PM2 worker 1 ─ :9465/metrics ┤
node_exporter ─ :9100        ├─► Prometheus :9090 ──► Grafana :3300
(host CPU/mem/disk)          ┘        (Docker Compose, all 127.0.0.1)
```

## What the app exposes
`src/metrics.js` gives each PM2 cluster worker its own metrics server on
`127.0.0.1:(9464 + worker_index)`:
- **Node runtime** — event-loop lag, heap, GC pauses, CPU, open handles (`nodejs_*`, `process_*`)
- **HTTP** — `http_request_duration_seconds` (histogram, labelled by `method`, `route`, `status_code`) and `http_requests_in_flight`

Because we run PM2 **cluster** mode, each worker is scraped as a separate target
(the app port's load balancer would otherwise randomise scrapes). The `route`
label uses the Express route *pattern* (`/users/:id`) to keep cardinality bounded.

## 1. Ship the app change
On the box:
```bash
cd ~/backend-personal
git pull
npm install                       # pulls in prom-client
pm2 restart app worker --update-env   # app workers + BullMQ worker expose /metrics
# verify:
curl -s 127.0.0.1:9464/metrics | head   # app worker 0
curl -s 127.0.0.1:9465/metrics | head   # app worker 1
curl -s 127.0.0.1:9470/metrics | head   # background worker
```
> If you change `WEB_CONCURRENCY`, update the worker port list in
> `prometheus/prometheus.yml` to match (worker N → port 9464 + N).

## 2. Start the monitoring stack
Install Docker + the compose plugin if needed:
```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker    # run docker without sudo
```
Then:
```bash
cd ~/backend-personal/monitoring
GRAFANA_ADMIN_PASSWORD='pick-a-strong-one' docker compose up -d
docker compose ps                 # all three Up
```

## 3. View it (SSH tunnel — no public ports)
From your laptop:
```bash
ssh -L 3300:localhost:3300 -L 9090:localhost:9090 ubuntu@<your-elastic-ip>
```
- **Prometheus** → http://localhost:9090/targets — every target should be **UP**
  (2 backend workers, node, prometheus).
- **Grafana** → http://localhost:3300 — log in as `admin` / the password you set.
  The Prometheus datasource is already wired up.

## 4. Dashboards
The **AVE Backend** dashboard is auto-provisioned (Grafana → Dashboards → *AVE*
folder) — HTTP rate/latency/errors, in-flight, Node runtime (app + worker) and
host CPU/memory. No manual building needed; it appears on first start.

Optionally import **1860** (*Node Exporter Full*) for deep host detail:
Grafana → **Dashboards → New → Import → 1860** → pick the Prometheus datasource.

The panels are driven by these queries (handy for ad-hoc **Explore**):
```promql
# Request rate by route
sum(rate(http_request_duration_seconds_count[5m])) by (route)

# p95 latency by route
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))

# Error rate (5xx) %
100 * sum(rate(http_request_duration_seconds_count{status_code=~"5.."}[5m]))
    / sum(rate(http_request_duration_seconds_count[5m]))

# In-flight requests (per worker)
http_requests_in_flight

# Event-loop lag p99 (saturation signal)
nodejs_eventloop_lag_p99_seconds

# Heap used per worker
process_resident_memory_bytes
```

## Security notes
- Everything listens on `127.0.0.1` only. **Do not** open 3300 / 9090 / 9100 / 9464
  in the EC2 security group — use the SSH tunnel.
- `/metrics` is on a **separate loopback port**, never on the public API.
- Change the Grafana admin password on first login; never commit it (pass it via
  the env var above, not a committed `.env`).

## Cost / footprint
On a `t3.medium` (4 GB) the stack adds ~400 MB (Prometheus ~200, Grafana ~120,
node_exporter ~20). Retention is capped at 15 days (`--storage.tsdb.retention.time`)
to bound disk. If the box feels tight, use the **Grafana Cloud** path in
[`grafana-cloud/`](./grafana-cloud/) instead — a single ~50 MB Alloy agent that
`remote_write`s to Grafana Cloud (free tier), with no local Prometheus/Grafana.

## Deploys
`deploy.yml` runs `npm ci --omit=dev` and `pm2 restart app worker`, so new
dependencies (like `prom-client`) install and both processes restart automatically
on every deploy — no manual step after the first setup.

## Reboots
`restart: unless-stopped` brings the stack back after a reboot; PM2 (via `pm2 save`)
brings the app + its metrics servers back.
```
