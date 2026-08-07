# Amplr REST API

**Base URL:** `https://xacehhtgvubcqdoltazg.supabase.co/functions/v1/amplr-api`

## Authentication

All requests require an API key issued from the Amplr dashboard.

```
Authorization: Bearer amplr_<your_key>
```

Or via header alias: `X-Amplr-Key: amplr_<your_key>`

---

## Issue Your First Key

In the Supabase SQL editor (or dashboard Settings → API Keys):

```sql
select * from amplr_create_api_key(auth.uid(), 'My App');
```

Returns the raw key **once** — store it immediately.

---

## Rate Limits

| Plan | Requests/min |
|------|-------------|
| Default | 30 |
| Custom | Set per-key |

On rate limit: `HTTP 429` with `Retry-After` header.

---

## Endpoints

### `POST /jobs` — Create a post job

Queues a job to post `message` to one or more Facebook groups. The paired Chrome extension picks it up within ~60 seconds.

**Request body:**

```json
{
  "message":     "Your post text here",
  "groups":      ["https://www.facebook.com/groups/123", "..."],
  "delay":       30,
  "image_url":   "https://...",
  "ai_enabled":  false,
  "ai_prompt":   "Rewrite as a punchy ad",
  "webhook_url": "https://yourapp.com/webhooks/amplr"
}
```

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `message` | string | ✅ | — | Post content |
| `groups` | string[] | ✅ | — | Facebook group URLs, max 200 |
| `delay` | integer | | 30 | Seconds between posts (5–3600) |
| `image_url` | string | | null | Direct image URL to attach |
| `ai_enabled` | boolean | | false | Rewrite with AI before posting |
| `ai_prompt` | string | | null | AI system prompt override |
| `webhook_url` | string | | null | HTTPS URL to notify on completion |

**Response `201`:**

```json
{
  "job": {
    "id":          "uuid",
    "status":      "pending",
    "message":     "...",
    "groups":      [...],
    "created_at":  "2025-01-01T00:00:00Z"
  }
}
```

---

### `GET /jobs` — List jobs

```
GET /jobs?status=pending&limit=20&offset=0
```

| Param | Default | Notes |
|-------|---------|-------|
| `status` | all | `pending`, `processing`, `done`, `failed`, `cancelled` |
| `limit` | 20 | Max 100 |
| `offset` | 0 | Pagination cursor |

**Response `200`:**

```json
{
  "jobs": [...],
  "total": 45,
  "limit": 20,
  "offset": 0
}
```

---

### `GET /jobs/:id` — Get job

```
GET /jobs/550e8400-e29b-41d4-a716-446655440000
```

**Response `200`:** `{ "job": { ... } }`

---

### `DELETE /jobs/:id` — Cancel job

Only works on `pending` jobs. Returns `409` if the job is processing.

**Response `200`:** `{ "cancelled": true, "id": "..." }`

---

### `GET /groups` — List saved groups

```
GET /groups?limit=50&offset=0
```

Returns the groups saved to your Amplr dashboard.

---

### `POST /keys/rotate` — Rotate API key

Invalidates the calling key and returns a new one. The new key must be stored immediately.

**Response `200`:**

```json
{
  "api_key": "amplr_<new_key>",
  "message": "Store this key now — it will not be shown again."
}
```

---

### `GET /status` — Health check

Returns extension online status and pending job count.

**Response `200`:**

```json
{
  "ok": true,
  "extension_online": true,
  "extension_last_seen": "2025-01-01T12:00:00Z",
  "pending_jobs": 2,
  "api_version": "1.0.0"
}
```

---

## Webhooks

When `webhook_url` is set on a job, Amplr POSTs a JSON payload to your URL when the job finishes. Retried 3 times with exponential backoff (2s, 4s).

**Headers:**

```
Content-Type:    application/json
User-Agent:      Amplr-Webhook/1.0
X-Amplr-Event:  job.completed | job.failed
X-Amplr-Job-Id: <uuid>
```

**Payload:**

```json
{
  "event":         "job.completed",
  "job_id":        "uuid",
  "status":        "done",
  "success_count": 8,
  "total_groups":  10,
  "error":         null,
  "completed_at":  "2025-01-01T12:05:00Z"
}
```

---

## Error Format

All errors return a JSON body:

```json
{
  "error": "Human-readable message",
  "code":  "MACHINE_CODE"
}
```

| Code | Status |
|------|--------|
| `UNAUTHORIZED` | 401 |
| `REVOKED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `RATE_LIMITED` | 429 |
| `BAD_REQUEST` | 400 |
| `SERVER_ERROR` | 500 |

---

## Scopes

| Scope | Grants |
|-------|--------|
| `jobs:write` | Create + cancel jobs |
| `jobs:read` | List + get jobs |
| `groups:read` | List groups |
| `*` | All scopes |

---

## Quickstart (curl)

```bash
# Set your key
AMPLR_KEY="amplr_your_key_here"
BASE="https://xacehhtgvubcqdoltazg.supabase.co/functions/v1/amplr-api"

# Create a job
curl -X POST "$BASE/jobs" \
  -H "Authorization: Bearer $AMPLR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Check out our new product launch! 🚀",
    "groups": [
      "https://www.facebook.com/groups/example1",
      "https://www.facebook.com/groups/example2"
    ],
    "delay": 45,
    "webhook_url": "https://yourapp.com/hooks/amplr"
  }'

# Poll status
curl "$BASE/status" -H "Authorization: Bearer $AMPLR_KEY"

# List recent jobs
curl "$BASE/jobs?limit=10" -H "Authorization: Bearer $AMPLR_KEY"
```

---

## Setup

1. Run `supabase/api-migration.sql` in the Supabase SQL editor
2. Deploy the Edge Function: `supabase functions deploy amplr-api`
3. Issue your first key via the dashboard or SQL
4. The Chrome extension must be paired and online for jobs to execute
