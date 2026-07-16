#!/usr/bin/env bash
# Deploy the Kriya MCP server to Cloud Run.
# Usage: ./deploy.sh   (needs env.yaml — copy env.yaml.example and fill it in)
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${GCP_PROJECT:-instilplayv1}"
REGION="${GCP_REGION:-asia-east1}"
SERVICE="${SERVICE_NAME:-kriya-mcp}"

[[ -f env.yaml ]] || { echo "env.yaml missing — copy env.yaml.example and fill it in"; exit 1; }

gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --allow-unauthenticated \
  --env-vars-file env.yaml \
  --min-instances 0 \
  --max-instances 2 \
  --memory 256Mi

gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)'
