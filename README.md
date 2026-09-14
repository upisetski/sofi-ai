# Sofi — MVP Architecture

Sofi is an AI assistant for Viber. The MVP is intentionally small: Node.js + TypeScript + Fastify, PostgreSQL, OpenRouter, asynchronous processing via a PostgreSQL-backed job queue, Sentry, and cost/rate protection.

## 1. Product goal

Validate two hypotheses:

1. People are willing to use an AI assistant directly inside Viber.
2. Users can simply send Sofi a text message or a photo and expect her to understand what to do.

Build for simplicity, low cost, and fast iteration — not hypothetical scale.

## 2. Stack

### Backend
- Node.js
- TypeScript
- Fastify

Responsibilities:
- Viber webhook
- message processing
- conversations
- AI routing
- rate limiting
- usage/cost accounting
- analytics
- Viber responses

Suggested structure:

```
src/
  viber/
    webhook.ts
    send-message.ts
  ai/
    router.ts
    openrouter.ts
    prompts.ts
  conversations/
    service.ts
  jobs/
    worker.ts
  usage/
    service.ts
    limits.ts
  analytics/
    service.ts
  db/
    client.ts
    repositories/
  config/
    env.ts
  server.ts
```

### Database
**PostgreSQL**

Stores:
- users
- conversations
- messages
- AI requests
- jobs
- daily usage
- analytics events

Core tables:

```
users
conversations
messages
ai_requests
jobs
usage_daily
events
```

No Redis is required at MVP stage.

### Observability
- **Pino** for structured application logs
- **Sentry** for exceptions and API/worker errors

Prometheus/Grafana are intentionally deferred.

## 3. Viber request flow

Viber calls:

```
POST /viber/webhook
```

Flow:

```
Viber
  ↓
webhook
  ↓
validate webhook/signature
  ↓
save message to PostgreSQL
  ↓
create processing job
  ↓
HTTP 200
  ↓
background worker
  ↓
rate/budget guard
  ↓
AI Router
  ↓
OpenRouter
  ↓
save cost/metrics
  ↓
send response to Viber
  ↓
mark job done
```

The webhook must return quickly. AI generation is asynchronous.

## 4. Background queue

The MVP uses a **PostgreSQL-backed queue** instead of Redis/BullMQ.

`jobs` contains:

```
id
type
payload
status
attempts
available_at
locked_at
created_at
processed_at
error
```

Statuses:

```
pending
processing
done
failed
```

The worker runs inside the same Node.js application initially.

If real load appears later, move to:

```
Redis + BullMQ + dedicated workers
```

## 5. Message debouncing

Users may send several short messages in sequence:

> Sofi  
> look at this  
> here  
> make it shorter

Use a small debounce window (~500–1000 ms):

```
message arrives
  ↓
wait
  ↓
check for more messages from the same user
  ↓
combine context
  ↓
one AI request
```

Tune this after observing real behavior.

## 6. Conversations

Sofi keeps context using:

```
conversation summary
+
recent messages
```

Do not send unlimited history to the model.

Example summary:

> The user is preparing a birthday message for her mother. Desired style is warm and informal.

This supports follow-up instructions such as “make it warmer” without uncontrolled context growth.

## 7. AI layer

All model calls go through an internal **AI Router**:

```ts
ai.generate({
  input,
  conversation,
  hasImage,
  needsWeb
})
```

Use route classes rather than hard-coded model names:

- `cheap_text`
- `strong_text`
- `vision`
- `web`

Business logic should not depend on one provider/model.

### OpenRouter

OpenRouter is the primary AI gateway because it:
- exposes multiple models through one API
- makes model/provider experiments cheap to implement
- supports provider routing
- supports web search

## 8. Web search

Use web search only when current information is required.

Examples:
- current prices
- today's news
- current rules
- opening hours

No search for ordinary writing, rewriting, explanations, or translation.

Flow:

```
message
  ↓
router
  ↓
needs_web?
  ├─ no → normal LLM
  └─ yes
       ↓
    web search
       ↓
    LLM + retrieved info
       ↓
    answer + sources
```

## 9. Vision

Launch supports:
- text
- images

No video, audio, or document processing initially.

Image flow:

```
Viber temporary media URL
  ↓
download
  ↓
vision model
  ↓
answer
  ↓
remove temporary file
```

Typical uses:
- read text from a photo
- understand a screenshot
- explain an image
- read an announcement/instruction

Resize images when possible to reduce cost and latency.

## 10. Rate limits and cost protection

Sofi is free, so runaway AI spending is a first-class risk.

### Per-user limits

Initial values:

```
FREE_USER_DAILY_BUDGET = $0.03

FREE_USER_MESSAGES_PER_DAY = 50
FREE_USER_IMAGES_PER_DAY = 10
FREE_USER_WEB_SEARCHES_PER_DAY = 10

MAX_MESSAGES_PER_MINUTE = 10
MAX_MESSAGES_PER_10_SECONDS = 3

MAX_COST_PER_REQUEST = $0.01

MAX_INPUT_TOKENS = 8,000
MAX_CONTEXT_TOKENS = 8,000
MAX_IMAGE_SIZE = 10 MB
```

The primary user budget is in **USD**, not tokens, because text, vision, web search, and models have different economics.

### Global limits

```
GLOBAL_DAILY_BUDGET = $5
GLOBAL_MONTHLY_BUDGET = $100
```

Thresholds:
- 80% → alert
- 90% → economy mode
- 100% → stop new AI requests

### Economy mode

When the global budget is close to the limit:
- use the cheapest text model
- disable web search
- restrict vision
- reduce context

### Budget reservation

Before calling OpenRouter, estimate maximum possible cost and reserve that amount.

Example:

```
daily_spent   = $0.020
estimated_max = $0.008
daily_limit   = $0.030
```

Allowed.

After completion:
- record actual cost
- release unused reservation

### Rate-limit flow

```
job
  ↓
Rate Limit / Budget Guard
  ├─ DENY → send limit message
  └─ ALLOW
       ↓
    reserve budget
       ↓
    AI Router
       ↓
    OpenRouter
       ↓
    actual cost
       ↓
    update usage
       ↓
    Viber response
```

Users should not see internal dollar/token accounting.

Example user-facing message:

> На сегодня я уже потратила весь свой бесплатный лимит 😄 Давай продолжим завтра.

## 11. Analytics

The MVP must learn what people actually use Sofi for.

Per request, record:
- input type
- intent
- route/model
- input/output tokens
- cost
- latency
- web usage
- follow-up behavior

Initial intents:
- `write`
- `rewrite`
- `explain`
- `ideas`
- `vision`
- `other`

Important metrics:
- new users
- conversations
- messages/user
- returning users
- D1/D7/D30 retention
- intent distribution
- image usage
- web usage
- AI cost
- cost/user
- follow-up rate
- latency
- errors

A strong quality signal is:

```
answer → follow-up
```

Examples:
- “Make it shorter.”
- “Make it warmer.”
- “Not so formal.”

## 12. Privacy / data minimization

Store only what is necessary.

At launch:
- keep Viber user ID
- optionally keep name if needed for the product
- do not persist avatar
- keep message history only as long as needed for product operation/debugging
- do not put full user content into ordinary logs

Images are processed temporarily and removed.

External AI requests should be routed with appropriate provider privacy/ZDR controls where available.

Before public launch, verify Belarusian personal-data requirements, retention, consent language, and cross-border processing with legal counsel.

## 13. Admin / dashboard

Do not build a full custom admin panel initially.

Start with PostgreSQL queries and/or:

**Metabase → PostgreSQL**

Useful dashboards:
- users
- new users
- messages
- sessions
- top intents
- image usage
- web usage
- AI cost
- cost/user
- retention

Technical monitoring:
- Railway logs
- Sentry

## 14. Deployment

Recommended platform: **Railway**.

MVP:

```
Railway Project
│
├── app
│   └── Node.js + Fastify
│
└── PostgreSQL
```

Why Railway:
- GitHub-based deploys
- managed PostgreSQL
- environment variables/secrets
- public HTTPS
- private networking
- easy path to separate workers later

No Redis, separate worker service, or object storage initially.

Environment variables:

```
VIBER_AUTH_TOKEN
OPENROUTER_API_KEY
DATABASE_URL
SENTRY_DSN
NODE_ENV
```

Health check:

```
GET /health
```

Expected response:

```json
{ "status": "ok" }
```

## 15. What is intentionally NOT in the MVP

- Redis
- BullMQ
- S3/object storage
- Prometheus
- Grafana
- ClickHouse
- Kafka
- Kubernetes
- microservices
- custom admin frontend

Add each only when a real problem justifies it.

## 16. Evolution path

### Stage 0 — Launch

```
Viber
 ↓
Node.js
 ↓
PostgreSQL
 ↓
OpenRouter
```

### Stage 1 — Real users

Improve:
- analytics
- rate limits
- cost controls
- prompts/models
- PostgreSQL queue

### Stage 2 — Significant load

Add:

```
Redis
BullMQ
dedicated workers
object storage
```

### Stage 3 — Larger product

Potentially add:
- Prometheus
- Grafana
- analytics database
- dedicated services

## Core principle

**Build the smallest system that is reliable, observable, and safe from runaway AI costs.**

The MVP does not need to serve one million users.

It needs to be:
- cheap
- easy to deploy
- easy to debug
- protected against accidental AI overspending
- easy to change based on the first real user data

The main investment should go into:

**UX → response quality → vision → web search → analytics of real user behavior.**
