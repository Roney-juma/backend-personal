# Grafana Cloud monitoring (lightweight alternative)

Runs a single **Grafana Alloy** agent that scrapes the app + worker + host metrics
locally and `remote_write`s them to **Grafana Cloud** (free tier). Dashboards live
in Grafana Cloud, so there's **no local Prometheus or Grafana** — the box only runs
the ~50 MB agent instead of the ~400 MB self-hosted stack.

> Use **this** OR the self-hosted `monitoring/docker-compose.yml`, not both.

The app instrumentation is identical either way — `src/metrics.js` already exposes
per-worker `/metrics`; only the collection/storage layer differs.

## 1. Get Grafana Cloud credentials (free)
1. Create a free account at <https://grafana.com/> → a stack is provisioned.
2. In the portal: **Connections → Add new connection → Hosted Prometheus metrics**
   (a.k.a. "Prometheus" / "Send Metrics"). It shows:
   - **Remote write endpoint** → `GRAFANA_CLOUD_PROM_URL`
     (e.g. `https://prometheus-prod-XX-region.grafana.net/api/prom/push`)
   - **Username / Instance ID** (a number) → `GRAFANA_CLOUD_PROM_USER`
3. Create a token: **Access Policies → Create access policy** with scope
   `metrics:write`, then **Add token** → that token is `GRAFANA_CLOUD_API_KEY`.

## 2. Run the agent on the box
```bash
cd ~/backend-personal/monitoring/grafana-cloud
export GRAFANA_CLOUD_PROM_URL='https://prometheus-prod-XX-region.grafana.net/api/prom/push'
export GRAFANA_CLOUD_PROM_USER='123456'
export GRAFANA_CLOUD_API_KEY='glc_...'
docker compose up -d
docker compose logs -f alloy      # look for successful remote_write, no 401s
```
> Keep credentials out of git — pass them as env vars (as above) or put them in a
> gitignored `.env` next to the compose file. The `GRAFANA_CLOUD_API_KEY` is a
> write token; treat it like a password.

## 3. View in Grafana Cloud
- Open your stack's Grafana (`https://<your-stack>.grafana.net`).
- **Explore** → pick the `grafanacloud-<stack>-prom` datasource → run the same
  PromQL from `../README.md` (request rate, p95 latency, 5xx %, event-loop lag).
- **Dashboards → Import** the ready-made app dashboard: upload
  `../grafana/dashboards/ave-backend.json` (or paste its JSON) and pick your
  `grafanacloud-<stack>-prom` datasource. Also import **1860** for host detail.

## Notes
- Alloy makes only **outbound HTTPS** to Grafana Cloud — no inbound ports opened.
  Its debug UI is bound to `127.0.0.1:12345` (reach via SSH tunnel if needed).
- Host metrics come from Alloy's built-in `prometheus.exporter.unix` — no separate
  node_exporter container needed.
- If you change `WEB_CONCURRENCY`, update the worker target list in `config.alloy`
  to match (worker N → 9464 + N).
- Free tier: ~10k active series / 14-day retention — plenty for this backend.
